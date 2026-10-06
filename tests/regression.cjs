// Run with: node --experimental-vm-modules tests/regression.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

async function load(file, globals = {}) {
    const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout, ...globals })
    const modules = new Map()
    async function moduleFor(filename) {
        filename = path.resolve(filename)
        if (modules.has(filename)) return modules.get(filename)
        const module = new vm.SourceTextModule(fs.readFileSync(filename, 'utf8'), { context, identifier: filename })
        modules.set(filename, module)
        await module.link((specifier, parent) => moduleFor(path.resolve(path.dirname(parent.identifier), specifier)))
        return module
    }
    const module = await moduleFor(file)
    await module.evaluate()
    return module.namespace
}

async function main() {
    let response = { message: 'Database unavailable' }
    const { DBSheet } = await load('scripts/gsheet-db-client.js', {
        fetch: async () => ({ ok: true, json: async () => response }),
    })
    const sheet = new DBSheet('https://example.invalid')
    for (const method of ['doGet', 'doPost']) {
        await assert.rejects(sheet[method]({}), error => error.message === 'Database unavailable')
    }
    response = { columns: ['a'], data: [[1]] }
    assert.equal(await sheet.doGet({}), response)

    const { sql, inner_join, left_join, transpose } = await load('scripts/sql.js')
    const table = { columns: ['first', 'second'], data: [[1, 2]] }
    sql({ update: table, set: { first: 3 } })
    assert.deepEqual(table, { columns: ['first', 'second'], data: [[3, 2]] })
    const keys = { columns: ['a', 'b'], data: [['a+b', 'c'], ['a', 'b+c'], ['__proto__', 'x']] }
    assert.equal(inner_join(keys, keys, ['a', 'b']).data.length, 3, 'Composite join keys must not collide')
    assert.equal(left_join(keys, { columns: ['a', 'b'], data: [] }, ['a', 'b']).data.length, 3)
    const transposed = transpose({ columns: ['id', 'x', 'y'], data: [[1, 'a', 'b'], [2, '', 'c']] }, ['x', 'y'], ['key', 'value'])
    assert.equal(JSON.stringify(transposed.data), JSON.stringify([[1, 'x', 'a'], [1, 'y', 'b'], [2, 'y', 'c']]))

    const requests = []
    const container = { textContent: '', appendChild(button) { this.retry = button } }
    let fail = true
    const app = await load('scripts/attendance.js', {
        window: { location: 'https://example.invalid/attendance.html?db=test' },
        document: { getElementById: () => container, createElement: () => ({}) },
        fetch: async url => {
            requests.push(JSON.parse(new URL(url).searchParams.get('sql')).from)
            if (fail) throw new Error('Offline')
            return { ok: true, json: async () => ({ message: 'Test server error' }) }
        },
    })
    assert.equal(requests.length, 0, 'Import must not block on database requests')
    await app.run_select()
    assert.deepEqual(requests, ['sessions'], 'Sessions have startup priority')
    assert.match(container.textContent, /Offline/)
    assert.equal(container.retry.textContent, 'Retry')
    fail = false
    await container.retry.onclick()
    assert.deepEqual(requests, ['sessions', 'sessions'], 'Failed reads can be retried')
    assert.match(container.textContent, /Test server error/)
    await attendanceTests()
    await dateTests()
    console.log('Passed: database errors, startup/retry, joins, transpose, rendering, attendance saves, rollback, comments, swaps, and navigation races.')
}

async function dateTests() {
    class Sunday extends Date {
        constructor(...args) { super(...(args.length ? args : ['2026-10-11T15:00:00'])) }
    }
    const { getweeks, selected_date } = await load('scripts/utils.js', {
        Date: Sunday,
        window: { location: 'https://example.invalid/?Week=w1_1&Day=Sunday&year=2026' },
    })
    const calendar = { columns: ['year', 'Week', 'begins'], data: [[2025, 'w1_1', '2025-10-06T00:00:00'], [2026, 'w1_1', '2026-10-05T00:00:00']] }
    assert.equal(getweeks(calendar, { columns: ['w1_1'], data: [[1]] })[1], 'w1_1', 'Sunday afternoon belongs to the week')
    const selected = selected_date(calendar)
    assert.equal(selected.getFullYear(), 2026, 'Date must come from the selected year')
    assert.equal(selected.getDate(), 11, 'Sunday must resolve to the last day of the selected week')
    class LocalMidnight extends Date {
        getFullYear() { return 2026 }
        getMonth() { return 5 }
        getDate() { return 2 }
        toISOString() { return '2026-06-01T23:30:00.000Z' }
        toTimeString() { return '00:30:00 GMT+0100' }
    }
    const { localTime } = await load('scripts/utils.js', { Date: LocalMidnight })
    assert.equal(localTime(), '2026-06-02 00:30:00', 'Timestamp date and time must use the same timezone')
}

async function attendanceTests() {
    const elements = new Map()
    function element(id = '') {
        const classes = new Set()
        const node = {
            id, value: '', textContent: '', disabled: false, style: { display: 'none' },
            classList: {
                add: (...names) => names.forEach(n => classes.add(n)),
                remove: (...names) => names.forEach(n => classes.delete(n)),
                contains: name => classes.has(name),
                replace(a, b) { classes.delete(a); classes.add(b) },
                toggle(name) { classes.has(name) ? classes.delete(name) : classes.add(name) },
            },
            setAttribute() {}, prepend(child) { this.status = child }, appendChild() {},
            addEventListener(type, fn) { this[type] = fn },
            showModal() { this.returnValue = this.answer || ''; this.close() },
        }
        elements.set(id, node)
        return node
    }
    const container = element('container')
    Object.defineProperty(container, 'innerHTML', {
        set(html) {
            this.html = html
            for (const match of html.matchAll(/id="([^"]+)"|id='([^']+)'/g)) element(match[1] || match[2])
        },
    })
    for (const id of ['warning', 'warning2', 'swap', 'swap_ub']) element(id)
    const document = {
        getElementById: id => elements.get(id), createElement: () => element(),
        querySelector: selector => elements.get(selector.slice(1)),
        querySelectorAll: selector => [...elements.values()].filter(e => e.id.startsWith(selector === '.chooser' ? 'attend_' : 'toggle_')),
    }
    const year = new Date().getFullYear()
    const tables = {
        sessions: { columns: ['Module', 'Lesson', 'Day', 'Time', 'Group', 'w1_1'], data: [['M', 'L', 'Monday', '09:00', 'A', 2]] },
        calendar: { columns: ['year', 'Week', 'begins'], data: [[year, 'w1_1', `${year}-01-05`]] },
        students: { columns: ['UB Number', 'First name', 'Last name'], data: [[1, '<script>', 'Name']] },
        L: { columns: ['UB Number', 'Group', 'session1', 'session2', 'comment2'], data: [[1, 'A', 'AGC', '', '</textarea><script>bad</script>'], [2, 'A', null, '', '']] },
    }
    const writes = []
    let release
    let failWrite = false
    let delayWrite = false
    const app = await load('scripts/attendance.js', {
        document,
        window: { location: `https://example.invalid/?db=test&Module=M&Lesson=L&Week=w1_1&Day=Monday&Time=09:00&Group=A` },
        fetch: async url => {
            const query = JSON.parse(new URL(url).searchParams.get('sql'))
            if (query.from === 'students') {
                assert.deepEqual(query.select, ['UB Number', 'First name', 'Last name', 'info'], 'Only request student fields used by attendance')
            }
            if (!query.update) return { ok: true, json: async () => tables[query.from] }
            writes.push(query)
            if (delayWrite) await new Promise(resolve => { release = resolve })
            if (failWrite) throw new Error('Offline')
            return { ok: true, json: async () => ({ rows: [2] }) }
        },
    })
    await app.run_select()
    assert.ok(elements.has('attend_2'), 'Student without a directory entry must remain visible')
    assert.ok(container.html.includes('&lt;script&gt;'), 'Names must be escaped')
    assert.ok(container.html.includes('&lt;/textarea&gt;'), 'Comments must be escaped')
    assert.ok(container.html.includes('color:lightblue'), 'AGC history must be distinguished from attendance')
    const button = elements.get('attend_1')
    delayWrite = true
    const click = button.onclick({ currentTarget: button, target: {} })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(button.disabled, true)
    await button.onclick({ currentTarget: button })
    assert.equal(writes.length, 1, 'Repeated click must not send a competing save')
    release()
    await click
    assert.equal(button.disabled, false)
    assert.equal(button.classList.contains('present'), true)
    delayWrite = false
    elements.get('warning').answer = 'yes'
    failWrite = true
    await button.onclick({ currentTarget: button })
    assert.equal(button.classList.contains('present'), true, 'Failed save restores previous appearance')
    assert.match(container.status.textContent, /Save not confirmed/)
    failWrite = false
    await button.onclick({ currentTarget: button })
    assert.equal(button.classList.contains('present'), false)
    const comment = elements.get('comment_1')
    comment.value = 'New comment'
    await comment.onchange()
    assert.equal(writes.at(-1).set.comment2, 'New comment')
    const swap = elements.get('register_swap')
    elements.get('swap').answer = 'ok'
    elements.get('swap_ub').value = ''
    const before = writes.length
    await swap.onclick({ currentTarget: swap })
    assert.equal(writes.length, before, 'Empty swap must not write')
    elements.get('swap_ub').value = '2'
    await swap.onclick({ currentTarget: swap })
    assert.equal(writes.at(-1).where[2], '2')
    assert.equal(elements.get('attend_2').classList.contains('present'), true)
    await Promise.all([app.run_select(), app.run_select()])
    assert.ok(container.html.includes('attend_1'), 'Overlapping navigation must resolve to a register')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
