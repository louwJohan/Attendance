const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict')
let data, reads, writes, locked, released, busy = false
function reset() { data = [['UB Number', 'session1', 'comment1', 'unused'], [123, '', '', '=formula'], [456, '', '', 'keep']]; reads = []; writes = 0; locked = false; released = false }
const sheet = {
    getLastColumn: () => data[0].length, getLastRow: () => data.length, getMaxRows: () => 100,
    getRange(r, c, h = 1, w = 1) {
        assert.ok(r > 0 && c > 0 && h > 0 && w > 0)
        return {
            getValues() { reads.push([r,c,h,w]); return data.slice(r-1,r-1+h).map(row => row.slice(c-1,c-1+w)) },
            setValues(rows) { assert.ok(locked); writes++; rows.forEach((row,i) => { data[r-1+i] ||= []; row.forEach((v,j) => data[r-1+i][c-1+j] = v) }) },
        }
    },
    getRangeList(addresses) { return {setValue(value) { assert.ok(locked); writes++; for (const address of addresses) {
        const [, letters, row] = /^([A-Z]+)(\d+)$/.exec(address)
        const column = [...letters].reduce((n,c) => n*26+c.charCodeAt(0)-64,0)
        data[Number(row)-1][column-1] = value
    }}} },
}
const context = vm.createContext({
    SpreadsheetApp: {openById: () => ({getSheetByName: () => sheet}), flush() {}},
    LockService: {getScriptLock: () => ({tryLock() { if(busy) return false; locked = true; return true }, releaseLock() { locked = false; released = true }})},
    ContentService: {MimeType: {JSON:'json'}, createTextOutput: text => ({text,setMimeType() {return this}})},
})
vm.runInContext(fs.readFileSync('backend/attendance-backend-fixed.txt','utf8'),context)
const teacher = vm.runInContext('Object.keys(permits).find(k => permits[k].update)',context)
const student = vm.runInContext('Object.keys(permits).find(k => !permits[k].update)',context)
let count = 0
function test(name, fn) { reset(); fn(); count++; console.log('PASS '+name) }
const update = extra => context.runSQL({db:teacher,update:'lesson',where:['UB Number','=','123'],set:{session1:'present'},...extra})
test('Attendance filter, preserved formulas, narrow reads and lock release', () => {
    assert.equal(JSON.stringify(update().rows),'[2]'); assert.equal(data[1][1],'present'); assert.equal(data[2][1],'')
    assert.equal(data[1][3],'=formula'); assert.deepEqual(reads,[[1,1,1,4],[2,1,2,1]]); assert.ok(released)
})
test('Student cannot update or insert into lesson', () => {
    assert.throws(()=>update({db:student}),/Permission/)
    assert.throws(()=>context.doInsert({db:student,insert_into:'lesson',columns:['UB Number'],valuelist:[789]}),/Permission/)
    assert.equal(writes,0)
})
test('Allowed student insert; flat and nested rows', () => {
    for(const valuelist of [[789],[[890],[901]]]) context.doInsert({db:student,insert_into:'absence reports',columns:['UB Number'],valuelist})
    assert.equal(data.length,6); assert.equal(data[3][0],789); assert.equal(data[5][0],901)
})
test('Exact insert permission matching',()=>assert.throws(()=>context.doInsert({db:student,insert_into:'absence',columns:['UB Number'],valuelist:[1]}),/Permission/))
test('Unknown field validation prevents partial writes',()=>{
    assert.throws(()=>update({set:{session1:'present',missing:'x'}}),/Unknown column/); assert.equal(writes,0); assert.ok(released)
})
test('Zero limit and invalid limits',()=>{
    assert.equal(update({limit:0}).rows.length,0); assert.equal(writes,0)
    assert.throws(()=>update({limit:-1}),/limit/)
})
test('Bad filters rejected before writing',()=>{
    for(const where of [['misspelled','<>',''],['UB Number','bad',123],null]) assert.throws(()=>update({where}))
    assert.equal(writes,0)
})
test('Right-hand column-like strings remain literals',()=>{
    assert.equal(update({where:['UB Number','=','UB Number']}).rows.length,0)
    assert.equal(update({where:['UB Number','=',{column:'UB Number'}]}).rows.length,2)
})
test('Percent text survives GET; errors have messages',()=>{
    const q={db:teacher,update:'lesson',where:['UB Number','=',123],set:{comment1:'100% and %20'}}
    const response=context.doGet({parameter:{sql:JSON.stringify(q)}})
    assert.equal(JSON.parse(response.text).rows.length,1); assert.equal(data[1][2],'100% and %20')
    assert.ok(JSON.parse(context.doGet({parameter:{sql:'bad'}}).text).message)
})
test('Projected select reads only requested body column',()=>{
    const result=context.doSelect({db:teacher,from:'lesson',select:['UB Number']})
    assert.equal(JSON.stringify(result.data),'[[123],[456]]'); assert.deepEqual(reads,[[1,1,1,4],[2,1,2,1]])
})
test('Duplicate headers and unknown select columns fail',()=>{
    assert.throws(()=>context.run_select({select:'missing'},data[0],data.slice(1)),/Unknown/)
    assert.throws(()=>context.names_to_columns(['x','x']),/duplicate/)
    assert.equal(context.names_to_columns(['constructor']).constructor,0)
})
test('Sorting ties advance to next key',()=>{
    const compare=context.comparison([['date','ascdate'],['rank','asc']],{date:0,rank:1})
    assert.equal(compare(['2026-01-01',2],['01/01/2026',1]),1)
})
test('Compound filters, distinct, and sort',()=>{
    const result=context.run_select({select:['UB Number'],where:[['UB Number','in',[123,456]],'&&',['session1','=','']],order_by:[['UB Number','desc']],distinct:true},data[0],data.slice(1))
    assert.equal(JSON.stringify(result.data),'[[456],[123]]')
})
test('Invalid later insert row prevents earlier row being written',()=>{
    assert.throws(()=>context.doInsert({db:teacher,insert_into:'lesson',columns:['UB Number'],valuelist:[[789],[890,'extra']]}),/does not match/); assert.equal(writes,0)
})
test('Busy lock prevents writes',()=>{
    busy=true; try {assert.throws(()=>update(),/busy/); assert.equal(writes,0)} finally {busy=false}
})
test('Missing filter requires explicit all flag',()=>{
    assert.throws(()=>context.doUpdate({db:teacher,update:'lesson',set:{session1:'x'}}),/filter/)
    assert.equal(context.doUpdate({db:teacher,update:'lesson',all:true,set:{session1:'x'}}).rows.length,2)
})
test('POST and token compatibility',()=>{
    const sql={db:teacher,select:'*',from:'lesson'}
    vm.runInContext("token = 'test-token'",context)
    try {
        assert.match(JSON.parse(context.doPost({postData:{contents:JSON.stringify({sql})}}).text).message,/authorized/)
        assert.equal(JSON.parse(context.doPost({postData:{contents:JSON.stringify({sql,pin:'test-token'})}}).text).data.length,2)
    } finally { vm.runInContext('token = null',context) }
})
console.log(`${count} backend tests passed; all spreadsheet services mocked.`)
