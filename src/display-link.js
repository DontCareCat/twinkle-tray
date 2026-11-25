// Disconnects a display from the Windows desktop when Twinkle Tray turns it
// off, and reconnects it when Twinkle Tray turns it back on.
//
// Some displays stay "connected" while in standby, so Windows keeps putting
// windows and the mouse on them. Detaching the display while it's off avoids
// that. Once detached, Windows can no longer talk to it over DDC/CI, so it
// has to be reattached before it can be told to turn back on.
//
// All Windows access is passed in, so the logic can be tested without hardware:
//   getLayout()                 -> [{ devicePath, ... }] active displays (displayConfigForRestoration)
//   applyLayout({ config, persistent })   (restoreDisplayConfig)
//   getDisplayConfig()          -> [{ devicePath, inUse }] all connected displays (extractDisplayConfig)
//   toggleDisplays({ enable, disable, persistent })   fallback (toggleEnabledDisplays)
//   extendAll()                 last resort when reconnecting (DisplaySwitch /extend)

// "\\?\DISPLAY#BNQ7F87#5&2a1b&0&UID4354#{e6f07b5f-...}" vs hwid
// ["\\?\DISPLAY", "BNQ7F87", "5&2a1b&0&UID4354", "{e6f07b5f-...}"]
function devicePathMatchesHwid(devicePath, hwid) {
  if (typeof devicePath !== "string" || !Array.isArray(hwid) || hwid.length < 3) return false
  const parts = devicePath.split("#")
  if (parts.length < 3) return false
  return parts[1].toLowerCase() === String(hwid[1]).toLowerCase()
    && parts[2].toLowerCase() === String(hwid[2]).toLowerCase()
}

class DisplayLink {
  constructor(deps) {
    this.deps = deps
    this.log = deps.log || (() => {})
    this.onChange = deps.onChange || (() => {})
    // key -> { key, id, hwid, name, devicePath, layoutEntry, disconnectedAt }
    this.disconnected = new Map()
    this.busy = false
  }

  list() {
    return Array.from(this.disconnected.values()).map(({ key, id, hwid, name, devicePath, disconnectedAt }) => ({ key, id, hwid, name, devicePath, disconnectedAt }))
  }

  isDisconnected(key) {
    return this.disconnected.has(key)
  }

  // Entries saved by a previous run. Displays Windows has since reattached
  // (Win+P, a restart, replugging) are dropped.
  async restore(entries) {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (entry?.key && entry?.devicePath && Array.isArray(entry.hwid)) this.disconnected.set(entry.key, entry)
    }
    await this.prune()
  }

  // Forget displays that are active again, and ones that are no longer plugged in.
  async prune() {
    if (!this.disconnected.size) return false
    let config
    try {
      config = await this.deps.getDisplayConfig()
    } catch (e) {
      return false
    }
    let changed = false
    for (const [key, entry] of this.disconnected) {
      const paths = config.filter(c => c.devicePath === entry.devicePath)
      if (!paths.length || paths.some(c => c.inUse)) {
        this.log(`[DisplayLink] ${entry.name || key} is ${paths.length ? "active again" : "no longer connected"}, forgetting it`)
        this.disconnected.delete(key)
        changed = true
      }
    }
    if (changed) this.onChange(this.list())
    return changed
  }

  // Detach a display from the desktop. Returns true if it was detached.
  async disconnect(monitor) {
    if (!monitor?.key || !Array.isArray(monitor.hwid)) return false
    if (this.busy) return false
    this.busy = true
    try {
      const layout = await this.deps.getLayout()
      const layoutEntry = layout.find(e => devicePathMatchesHwid(e.devicePath, monitor.hwid))
      if (!layoutEntry) {
        this.log(`[DisplayLink] ${monitor.name || monitor.key} isn't part of the desktop, nothing to disconnect`)
        return false
      }
      const remaining = layout.filter(e => e.devicePath !== layoutEntry.devicePath)
      if (!remaining.length) {
        this.log(`[DisplayLink] ${monitor.name || monitor.key} is the only active display, leaving it connected`)
        return false
      }

      this.log(`[DisplayLink] Disconnecting ${monitor.name || monitor.key}`)
      try {
        // One change to the final layout. Disabling through the toggle first
        // re-enables everything, which makes Windows ask to keep the changes.
        await this.deps.applyLayout({ config: remaining, persistent: false })
      } catch (e) {
        this.log("[DisplayLink] Layout change failed, trying toggle", e?.message || e)
        await this.deps.toggleDisplays({ disable: [layoutEntry.devicePath], persistent: false })
      }

      this.disconnected.set(monitor.key, {
        key: monitor.key,
        id: monitor.id,
        hwid: monitor.hwid,
        name: monitor.name,
        devicePath: layoutEntry.devicePath,
        layoutEntry,
        disconnectedAt: (this.deps.now ? this.deps.now() : Date.now())
      })
      this.onChange(this.list())
      return true
    } finally {
      this.busy = false
    }
  }

  // Reattach a display detached by disconnect(). Returns the entry, or false.
  async connect(key) {
    const entry = this.disconnected.get(key)
    if (!entry) return false
    if (this.busy) return false
    this.busy = true
    try {
      this.log(`[DisplayLink] Reconnecting ${entry.name || key}`)
      let done = false
      try {
        const layout = await this.deps.getLayout()
        const config = layout.filter(e => e.devicePath !== entry.devicePath).concat([entry.layoutEntry])
        await this.deps.applyLayout({ config, persistent: false })
        done = true
      } catch (e) {
        this.log("[DisplayLink] Layout restore failed, trying toggle", e?.message || e)
      }
      if (!done) {
        try {
          await this.deps.toggleDisplays({ enable: [entry.devicePath], persistent: false })
          done = true
        } catch (e) {
          this.log("[DisplayLink] Toggle failed, extending to all displays", e?.message || e)
        }
      }
      if (!done && this.deps.extendAll) {
        await this.deps.extendAll()
        done = true
      }
      if (!done) throw new Error("Couldn't reconnect display")
      this.disconnected.delete(key)
      this.onChange(this.list())
      return entry
    } finally {
      this.busy = false
    }
  }

  async connectAll() {
    const reconnected = []
    for (const key of Array.from(this.disconnected.keys())) {
      try {
        const entry = await this.connect(key)
        if (entry) reconnected.push(entry)
      } catch (e) {
        this.log("[DisplayLink] Reconnect failed", e?.message || e)
      }
    }
    return reconnected
  }
}

module.exports = { DisplayLink, devicePathMatchesHwid }
