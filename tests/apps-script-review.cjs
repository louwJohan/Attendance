// Reproduce defects in the supplied backend without accessing Google Sheets.
// Usage: node tests/apps-script-review.cjs "path/to/code.gs.txt"
const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const source = fs.readFileSync(process.argv[2], 'utf8')
let data, opened, reads, writes
function reset() {
    data = [['UB Number', 'session1'], ['123', ''], ['456', '']]
    opened = []; reads = 0; writes = 0
}
reset()
const sheet = {
    getDataRange() {
        return {
            getValues() { reads++; return data.map(row => [...row]) },
            getLastColumn() { return 2 }, getLastRow() { return 3 },
        }
    },
    getRange(row, column, height = 1, width = 1) {
        if (!Number.isInteger(column) || column < 1) throw new Error('Invalid column')
        return {
            getValues() { return data.slice(row - 1, row - 1 + height).map(r => r.slice(column - 1, column - 1 + width)) },
            setValue(value) { data[row - 1][column - 1] = value; writes++ },
        }
    },
    appendRow(row) { data.push([...row]); writes++ },
}
const context = vm.createContext({
    SpreadsheetApp: { openById(id) { opened.push(id); return { getSheetByName: () => sheet } } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput(text) { return { text, setMimeType() { return this } } } },
    Logger: { log() {} },
})
vm.runInContext(source, context)
const cases = []
function check(name, test) { reset(); test(); cases.push(name) }
check('App string filter updates no rows; numeric filter updates every row', () => {
    assert.equal(context.doUpdate({ update: 'lesson', where: ['UB Number', '=', '123'], set: { session1: 'present' } }).rows.length, 0)
    assert.equal(context.doUpdate({ update: 'lesson', where: ['UB Number', '=', 123], set: { session1: 'present' } }).rows.length, 2)
})
check('Different db parameters open the same spreadsheet', () => {
    context.runSQL({ db: 'A', select: '*', from: 'students' })
    context.runSQL({ db: 'B', select: '*', from: 'students' })
    assert.equal(opened[0], opened[1])
})
check('GET with a literal percent sign fails and returns an empty error object', () => {
    const response = context.doGet({ parameter: { sql: JSON.stringify({ update: 'lesson', where: { 'UB Number': '123' }, set: { session1: '100% attendance' } }) } })
    assert.equal(response.text, '{}')
    assert.equal(writes, 0)
})
check('Insert writes a row, then fails in publish', () => {
    assert.throws(() => context.doInsert({ insert_into: 'lesson', values: { 'UB Number': '789' } }), /iterable/)
    assert.equal(data.length, 4)
})
check('Zero-valued comparisons throw instead of filtering', () => {
    const filter = context.make_where_filter({ session1: { ge: 0 } }, { session1: 1 })
    assert.throws(() => filter(['123', 1]), /not a function/)
})
check('Unknown selected columns become null rather than a schema error', () => {
    const response = context.doSelect({ select: ['missing'], from: 'students' })
    assert.equal(JSON.stringify(response.data), '[[null],[null]]')
})
check('An invalid update field can fail after an earlier field is saved', () => {
    assert.throws(() => context.doUpdate({ update: 'lesson', where: { 'UB Number': '123' }, set: { session1: 'present', missing: 'x' } }), /Invalid column/)
    assert.equal(data[1][1], 'present')
})
check('Selecting a subset still reads the full data range', () => {
    context.doSelect({ select: ['UB Number'], from: 'students' })
    assert.equal(reads, 1)
})
check('Array filters use OR despite the documented AND behavior', () => {
    const filter = context.make_where_filter([{ 'UB Number': '123' }, { session1: 'present' }], { 'UB Number': 0, session1: 1 })
    assert.equal(filter(['123', '']), true)
})
for (const name of cases) console.log('REPRODUCED: ' + name)
console.log(`${cases.length} defects/behaviors reproduced with mocks; no network requests or live writes.`)
