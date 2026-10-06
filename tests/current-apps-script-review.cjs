// Review the supplied routing backend with an in-memory spreadsheet.
// Run: node tests/current-apps-script-review.cjs "path/to/code.gs.txt" "path/to/utils.txt"
const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const source = fs.readFileSync(process.argv[2], 'utf8')
let data, reads
const sheet = {
    getDataRange: () => ({
        getValues() { reads++; return data.map(row => [...row]) },
        getLastColumn: () => 2, getLastRow: () => 3,
    }),
    getRange(row, col, height = 1, width = 1) {
        if (!Number.isInteger(col) || col < 1) throw new Error('Invalid column')
        return {
            getValues: () => data.slice(row - 1, row - 1 + height).map(r => r.slice(col - 1, col - 1 + width)),
            setValue(value) { data[row - 1][col - 1] = value },
        }
    },
    appendRow(row) { data.push([...row]) },
}
const context = vm.createContext({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this } }) },
})
vm.runInContext(source, context)
vm.runInContext(fs.readFileSync(process.argv[3], 'utf8'), context)
const studentDB = vm.runInContext('Object.keys(permits).find(key => !permits[key].update)', context)
function check(name, test) {
    data = [['UB Number', 'session1'], ['123', ''], ['456', '']]
    reads = 0
    test()
    console.log('REPRODUCED: ' + name)
}
check('Student role can update records despite lacking update permission', () => {
    const result = context.runSQL({ db: studentDB, update: 'lesson', set: { session1: 'present' } })
    assert.equal(result.rows.length, 2)
    assert.equal(data[1][1], 'present')
})
check('Student insert restriction is not enforced', () => {
    context.runSQL({ db: studentDB, insert_into: 'lesson', columns: ['UB Number'], valuelist: [['789']] })
    assert.equal(data.length, 4)
})
check('A literal percent sign fails GET parsing', () => {
    const response = context.doGet({ parameter: { sql: JSON.stringify({ db: studentDB, update: 'lesson', set: { session1: '100%' } }) } })
    assert.match(JSON.parse(response.text).message, /URI malformed/)
    assert.equal(data[1][1], '')
})
check('limit: 0 updates every row instead of zero rows', () => {
    const result = context.doUpdate({ db: studentDB, update: 'lesson', limit: 0, set: { session1: 'present' } })
    assert.equal(result.rows.length, 2)
})
check('Invalid update column fails after a previous field is saved', () => {
    assert.throws(() => context.doUpdate({ db: studentDB, update: 'lesson', set: { session1: 'present', missing: 'x' } }), /Invalid column/)
    assert.equal(data[1][1], 'present')
})
check('Flat insert row is interpreted as multiple rows', () => {
    context.doInsert({ db: studentDB, insert_into: 'lesson', columns: ['UB Number', 'session1'], valuelist: ['789', 'present'] })
    assert.equal(data.length, 5)
    assert.equal(data[3][0], '7')
})
check('Column projection still reads the full spreadsheet range', () => {
    context.doSelect({ db: studentDB, from: 'students', select: ['UB Number'] })
    assert.equal(reads, 1)
})
check('Normal attendance filter selects only the requested student (compatibility confirmed)', () => {
    const result = context.doUpdate({ db: studentDB, update: 'lesson', where: ['UB Number', '=', '123'], set: { session1: 'present' } })
    assert.equal(JSON.stringify(result.rows), '[2]')
    assert.equal(data[1][1], 'present')
    assert.equal(data[2][1], '')
})
check('Unknown select field silently returns null values', () => {
    const result = context.doSelect({ db: studentDB, from: 'students', select: ['missing'] })
    assert.equal(JSON.stringify(result.data), '[[null],[null]]')
})
check('A value identical to a column name is interpreted as a column reference', () => {
    const filter = context.predicate(['UB Number', '=', 'UB Number'], context.names_to_columns(data[0]))
    assert.equal(filter(['123', '']), true)
    assert.equal(filter(['456', '']), true)
})
check('Missing column names become literals, allowing malformed filters to match every row', () => {
    const filter = context.predicate(['misspelled', '<>', ''], context.names_to_columns(data[0]))
    assert.equal(filter(['123', '']), true)
    assert.equal(filter(['456', '']), true)
})
check('An inherited object property is treated as a column', () => {
    const cols = context.names_to_columns(['UB Number'])
    const filter = context.predicate(['UB Number', '=', 'constructor'], cols)
    assert.equal(filter(['constructor']), false)
})
check('Equal dates fall through to descending text comparison instead of the next sort key', () => {
    const compare = context.comparison([['date', 'ascdate'], ['rank', 'asc']], { date: 0, rank: 1 })
    assert.equal(compare(['2026-01-01', 2], ['01/01/2026', 1]), -1)
})
check('Duplicate headers silently select the last column', () => {
    const result = context.run_select({ select: 'UB Number' }, ['UB Number', 'UB Number'], [['123', '456']])
    assert.equal(JSON.stringify(result.data), '[["456"]]')
})
console.log('Both supplied files tested together. No network access or live writes.')
