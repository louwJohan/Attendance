/*
The sql object is a JSON object which encodes sql statements.

SELECT:
sql = {
	db: name of sheet 
	select: array of column names or a single name or '*'
	from: the name of the sheet in the spreadsheet
	condition: object specifying where
	ordering: array of [colname, direction] where the direction is 
	     'asc', 'ascdate', 'desc', 'descdate' (date ordering isn't alphabetic so needs to be specified)
	unique: true or false
}

condition can be:
	[opstring, left, right] where left & right are conditions (opstring is &,|,>=,>,<=,<,==,=,<>)
	string giving column name
	string giving value
	number
(NB this should be improved at some point)

SELECT returns an object {columns, data} where columns is an array of selected column names and data is an array of rows

INSERT:
sql = {
	db: name of sheet
	insert_into: name of sheet in the spreadsheet
	columns: the column names to insert
	valuelist: array of value arrays corresponding to the columns, or a single array?
}

INSERT adds a row to the table with the columns filled in according to the values.
It returns an object {sheet, length, added} where sheet=sql.insert_into, length is the new # of rows in the 
sheet, and added is the number of rows added

UPDATE:
sql = {
	db: name of sheet
	update: the name of the sheet to update
	condition: the rows selected (same as SELECT)
	values: an object where the keys are the columns and the values are what is written.
}

UPDATE returns {sheet, rows} where sheet is the name of the sheet and rows is an array of the row numbers updated
Note that the same value is applied to every row.
*/

export class DBSheet {
	constructor(url, pin) {
		this.url = url
		if (pin) { this.pin = pin }
	}
	
	doGet(sql, fetch_options) {
		// sql object encodes a sql request as above, which is put in as
		// the sql property of the get request.
		let url = this.url+'?'
		if (this.pin) {
			url += 'pin='+encodeURIComponent(this.pin)+'&'
		}
		url += 'sql='+encodeURIComponent(JSON.stringify(sql))
		return fetch(url, { cache: 'no-store', ...fetch_options }).then(async response => {
			if (response.ok) {
				let json = await response.json()
				if (json.message) {
					throw(json)
				}
				return json
			} else {
				throw {message: 'Error '+response.status, sql}
			}
		})
	}
	
	doPost(sql, fetch_options) {
		// sql object encodes a sql request as above, which is put in as
		// the sql property of the post body.
		let body = {}
		if (this.pin) {
			body.pin=this.pin
		}
		body.sql = sql
		body = JSON.stringify(body)
		return fetch(this.url, Object.assign({method: 'POST', body}, fetch_options)).then(async response => {
			if (response.ok) {
				let json = await response.json()
				if (json.message) {
					throw(json)
				}
				return json
			} else {
				throw {message: 'Error '+response.status, sql}
			}
		})
	}
}
