const test = require("node:test")
const assert = require("node:assert")
const { DisplayLink, devicePathMatchesHwid } = require("../src/display-link.js")

const path = (model, uid) => `\\\\?\\DISPLAY#${model}#5&264b77a2&0&${uid}#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}`
const BENQ = path("BNQ7F87", "UID4354")
const RAZER = path("RZR1402", "UID4352")
const LAPTOP = path("SDC419C", "UID512")
const monitorFor = (devicePath, name) => {
  const hwid = devicePath.split("#")
  return { key: hwid[2], id: hwid.join("#"), hwid, name }
}

// A fake Windows display setup: every connected display, and which are on the desktop
function makeRig({ connected = [LAPTOP, RAZER, BENQ], active = [LAPTOP, RAZER, BENQ], failLayout = false, failToggle = false } = {}) {
  const rig = {
    connected: [...connected],
    active: new Set(active),
    calls: [],
    deps: {
      getLayout: async () => rig.connected.filter(p => rig.active.has(p)).map(devicePath => ({ devicePath, pathBuffer: "saved:" + devicePath })),
      applyLayout: async ({ config, persistent }) => {
        rig.calls.push({ type: "layout", paths: config.map(c => c.devicePath), persistent })
        if (failLayout) throw new Error("layout failed")
        rig.active = new Set(config.map(c => c.devicePath))
      },
      getDisplayConfig: async () => rig.connected.map(devicePath => ({ devicePath, inUse: rig.active.has(devicePath) })),
      toggleDisplays: async ({ enable = [], disable = [] }) => {
        rig.calls.push({ type: "toggle", enable, disable })
        if (failToggle) throw new Error("toggle failed")
        enable.forEach(p => rig.active.add(p))
        disable.forEach(p => rig.active.delete(p))
      },
      extendAll: async () => {
        rig.calls.push({ type: "extend" })
        rig.connected.forEach(p => rig.active.add(p))
      },
      onChange: (list) => rig.changes.push(list)
    },
    changes: []
  }
  return rig
}

test("matches a Windows device path to a monitor's hwid", () => {
  assert.ok(devicePathMatchesHwid(BENQ, BENQ.split("#")))
  assert.ok(devicePathMatchesHwid(BENQ.toLowerCase(), BENQ.split("#")))
  assert.ok(!devicePathMatchesHwid(BENQ, RAZER.split("#")))
  assert.ok(!devicePathMatchesHwid(undefined, BENQ.split("#")))
  assert.ok(!devicePathMatchesHwid(BENQ, ["x"]))
})

test("turning a display off removes it from the desktop in one layout change", async () => {
  const rig = makeRig()
  const link = new DisplayLink(rig.deps)
  assert.strictEqual(await link.disconnect(monitorFor(BENQ, "BenQ")), true)
  assert.deepStrictEqual([...rig.active], [LAPTOP, RAZER])
  assert.deepStrictEqual(rig.calls, [{ type: "layout", paths: [LAPTOP, RAZER], persistent: false }])
  assert.strictEqual(link.isDisconnected(BENQ.split("#")[2]), true)
  assert.strictEqual(rig.changes.at(-1)[0].name, "BenQ")
  // What's reported to the UI doesn't carry the saved layout
  assert.strictEqual(link.list()[0].layoutEntry, undefined)
})

test("turning it back on restores its saved layout entry", async () => {
  const rig = makeRig()
  const link = new DisplayLink(rig.deps)
  const benq = monitorFor(BENQ, "BenQ")
  await link.disconnect(benq)
  const entry = await link.connect(benq.key)
  assert.strictEqual(entry.devicePath, BENQ)
  assert.deepStrictEqual(rig.calls[1], { type: "layout", paths: [LAPTOP, RAZER, BENQ], persistent: false })
  assert.ok(rig.active.has(BENQ))
  assert.deepStrictEqual(link.list(), [])
})

test("never disconnects the last active display", async () => {
  const rig = makeRig({ active: [BENQ] })
  const link = new DisplayLink(rig.deps)
  assert.strictEqual(await link.disconnect(monitorFor(BENQ)), false)
  assert.ok(rig.active.has(BENQ))
  assert.deepStrictEqual(rig.calls, [])
})

test("does nothing for a display that isn't on the desktop", async () => {
  const rig = makeRig({ active: [LAPTOP, RAZER] })
  const link = new DisplayLink(rig.deps)
  assert.strictEqual(await link.disconnect(monitorFor(BENQ)), false)
  assert.deepStrictEqual(link.list(), [])
})

test("falls back to the toggle when the layout change fails", async () => {
  const rig = makeRig({ failLayout: true })
  const link = new DisplayLink(rig.deps)
  const benq = monitorFor(BENQ)
  assert.strictEqual(await link.disconnect(benq), true)
  assert.deepStrictEqual(rig.calls[1], { type: "toggle", enable: [], disable: [BENQ] })
  await link.connect(benq.key)
  assert.deepStrictEqual(rig.calls.at(-1), { type: "toggle", enable: [BENQ], disable: [] })
  assert.ok(rig.active.has(BENQ))
})

test("extends to all displays as a last resort when reconnecting", async () => {
  const rig = makeRig()
  const link = new DisplayLink(rig.deps)
  const benq = monitorFor(BENQ)
  await link.disconnect(benq)
  rig.deps.applyLayout = async () => { throw new Error("31") }
  rig.deps.toggleDisplays = async () => { throw new Error("31") }
  assert.ok(await link.connect(benq.key))
  assert.deepStrictEqual(rig.calls.at(-1), { type: "extend" })
  assert.ok(rig.active.has(BENQ))
})

test("keeps the display listed when reconnecting fails completely", async () => {
  const rig = makeRig()
  delete rig.deps.extendAll
  const link = new DisplayLink(rig.deps)
  const benq = monitorFor(BENQ)
  await link.disconnect(benq)
  rig.deps.applyLayout = async () => { throw new Error("31") }
  rig.deps.toggleDisplays = async () => { throw new Error("31") }
  await assert.rejects(link.connect(benq.key))
  assert.strictEqual(link.isDisconnected(benq.key), true)
  assert.strictEqual(link.busy, false)
})

test("forgets displays Windows reattached or that were unplugged", async () => {
  const rig = makeRig()
  const link = new DisplayLink(rig.deps)
  await link.disconnect(monitorFor(BENQ))
  await link.disconnect(monitorFor(RAZER))
  assert.strictEqual(link.list().length, 2)

  // Win+P > Extend brings the BenQ back; the Razer gets unplugged
  rig.active.add(BENQ)
  rig.connected = rig.connected.filter(p => p !== RAZER)
  assert.strictEqual(await link.prune(), true)
  assert.deepStrictEqual(link.list(), [])
})

test("restores the list from a previous run, dropping displays that are active again", async () => {
  const rig = makeRig({ active: [LAPTOP, RAZER] })
  const link = new DisplayLink(rig.deps)
  const saved = [BENQ, RAZER].map(p => {
    const m = monitorFor(p)
    return { key: m.key, id: m.id, hwid: m.hwid, name: m.name, devicePath: p, layoutEntry: { devicePath: p } }
  })
  await link.restore(saved.concat([{ broken: true }]))
  assert.deepStrictEqual(link.list().map(e => e.devicePath), [BENQ])
})

test("ignores a second request while one is in progress", async () => {
  const rig = makeRig()
  const link = new DisplayLink(rig.deps)
  const first = link.disconnect(monitorFor(BENQ))
  assert.strictEqual(await link.disconnect(monitorFor(RAZER)), false)
  assert.strictEqual(await first, true)
  assert.deepStrictEqual([...rig.active], [LAPTOP, RAZER])
})
