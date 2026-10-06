// sql as a json object.

/*
Examples:
SELECT *
 FROM  Book
 WHERE price > 100.00
 ORDER BY title;

sql({
    select: '*',
    from: Book, // Book is a table object
    where: ['price', '>', 100],
    order_by: 'title'
})


A table object is just an object {columns, data} where
columns is an array of column names 
data is an array of table rows

For example:

{ 
    columns: ['a', 'b', 'c'],
    data: [[1,2,3], [4,5,6], [7,8,9]]
}

It has no special class or methods.

*/

export function sql(query) {
    /** a query object is a JSON encoding of a SQL query
     * One property, either select or update, determines what
     * sql query is executed.
     */

    if (query.select) {
        return do_select(query)
    }

    if (query.update) {
        return do_update(query)
    }
}

function do_select(query) {
    /** select some columns from a table object
     *
     * Parameters:
     *      query: an object with the following fields:
     *          select - an array of strings or '*' or a single string indicating which columns to select
     *          from - a table object {columns, data}
     *          where - (optional) an array which is turned into a predicate function
     *          distinct - (optional) true if the records should be distinct
     *          order_by - (optional) item or array of [order, order, ...] ordering specifications
     *          aggregate - (optional) a function to aggegate column values, or an array of such functions.
     *              Each function takes an array of values and returns a scalar.
     *          group_by - (optional) used when aggregates are defined.
     *
     * Returns:
     *      the table resulting from the query.
     */

    let table = Object.assign({}, query.from)

    // generate a column name -> column number mapping
    let colnumber = Object.fromEntries(
        Object.entries(table.columns).map((entry) => [entry[1], +entry[0]])
    )

    // Execute the where clause here because it can involve columns that aren't selected
    if (query.where) {
        table.data = table.data.filter(predicate(query.where, colnumber))
    }

    // Execute the order_by clause here because it can involve columns that aren't selected
    // order_by can be
    //     - a string, which indicates the column to sort by in ascending order
    //     - an object {colname: 'asc'|'desc'}
    //     - an array of strings or objects
    // see comparison function later
    if (query.order_by) {
        if (table.data === query.from.data) {
            table.data = [...table.data]
        }
        table.data.sort(comparison(query.order_by, colnumber))
    }

    // the select clause
    // select can be either:
    //    '*' - select all columns
    //    string - select the given column
    //    [string, string, ...] - select all the named columns in that order
    if (query.select != '*') {
        let select = [].concat(query.select),
            selectidx = select.map((c) => colnumber[c]).filter((i) => i != undefined)
        table.columns = selectidx.map((i) => table.columns[i])
        table.data = table.data.map((r) => selectidx.map((i) => r[i]))
    }

    // the aggregate clause. All the selected columns are aggregated using an aggregation
    // function. If there is a group_by clause in the query, the aggregation is over
    // the unique groups
    // aggregate works with group_by, but my version only allows grouping by a single column
    // the grouping column must be among the selected columns.
    if (query.aggregate) {
        if (!query.group_by) {
            table.data = [aggregator(query, table.columns, table.data)]
        } else {
            let groups = [
                    ...new Set(values(sql({ select: query.group_by, from: table }))),
                ],
                data = []
            for (let u of groups) {
                let T = sql({
                    select: '*',
                    from: table,
                    where: [query.group_by, '=', u],
                })
                data.push(aggregator(query, T.columns, T.data))
            }
            table.data = data
        }
    }

    // the distinct clause
    if (query.distinct) {
        let u = new Set(),
            udata = []
        for (let row of table.data) {
            let jsonrow = JSON.stringify(row)
            if (!u.has(jsonrow)) {
                u.add(jsonrow)
                udata.push(row)
            }
        }
        table.data = udata
    }

    return table
}

function aggregator(query, columns, rows) {
    /** carries out an aggregation on *all* the table columns
     *
     *  Parameters:
     *      query: the sql query object. We are interested in query.aggregate, which
     *          is an aggregation fuction or an array of such functions, one per column.
     *          An aggregation function takes an array of values and returns a single value
     *      columns: the column names of the table
     *      rows: the rows of the table
     *
     *  Returns:
     *     an aggergated row for a table.
     */
    let aggregate = [].concat(query.aggregate), // ensure we have an array
        data = []
    for (let c = 0; c < columns.length; c++) {
        // pick the aggregator function - either that corresponding to column c
        // or the last oen in the array
        let aggfn = aggregate[Math.min(c, aggregate.length - 1)],
            col = []
        // build the column
        for (let r = 0; r < rows.length; r++) {
            col[r] = rows[r][c]
        }
        // compute the aggregate for this column
        data[c] = aggfn(col)
    }
    return data // just one row
}

function do_update(query) {
    /** handle an update query.
     *
     *  Parameters:
     *      query: an object with the following properties:
     *          update - the table object to update
     *          where - which rows to update
     *          set - the values to update as an object {colname:value, colname:value}.
     *              Value may be an array or a function of the row.
     *              If colname doesn't exist, it is appended to the
     *              columns. This is bad when used with 'where'
     *
     *  Returns:
     *     the updated table
     */
    let table = Object.assign({}, query.update) // shallow copy

    // generate a column name -> column number mapping
    let colnumber = Object.fromEntries(
        Object.entries(table.columns).map((e) => [e[1], +e[0]])
    )

    // the where clause (this is why we want a shallow copy)
    if (query.where) {
        table.data = table.data.filter(predicate(query.where, colnumber))
    }

    // the set clause
    // set is an object {name:value, name:value...}
    for (let [name, value] of Object.entries(query.set)) {
        if (colnumber[name] === undefined) {
            table.columns.push(name)
            colnumber[name] = table.columns.length - 1
        }
        let idx = colnumber[name]
        if (Array.isArray(value)) {
            let [f, ...args] = value
            args = args.map((name) => colnumber[name])
            value = (r) => f(...args.map((i) => r[i]))
        }
        if (typeof value == 'function') {
            for (let row of table.data) {
                row[idx] = value(row)
            }
        } else {
            for (let row of table.data) {
                row[idx] = value
            }
        }
    }
    // return the full table
    return query.update
}

export function values(table, ...columns) {
    /** returns the values in a table column as an array
     *
     *  Parameters:
     *      table: a table object
     *      ...columns: a list of columns to return
     *
     *  Returns:
     *      if there is one column, it returns the specified column
     *      as an array. If more than one, it returns each column as
     *      and element of an array.
     *      If there are no columns, and table has just one column, then
     *      it is returned
     *
     * Example:
     *
     * Let table be
     * {
     *    columns: ['a', 'b', 'c'],
     *    data: [[1,2,3], [4,5,6], [7,8,9]]
     * }
     *
     * Then values(table, 'a') is [1,4,7] and
     * values(table, 'a','c') is [[1,4,7], [3, 6, 9]]
     */
    if (columns.length > 1) {
        // we run values for each column
        return columns.map((c) => values(table, c))
    } else if (columns.length == 1) {
        // we return that single column's values
        return values(sql({ select: columns[0], from: table }))
    } else {
        // we just return the single row of the table
        if (table.columns.length > 1) {
            throw "can't extract values"
        }
        return table.data.flat()
    }
}

export function ziprows(table) {
    /** zips the rows of the table together with columns to form
     *  an array of objects
     *
     *  Parameters:
     *      table: a table object
     *
     *  Returns:
     *      an array of objects.
     *
     *  Example:
     *
     * Let table be
     * {
     *    columns: ['a', 'b', 'c'],
     *    data: [[1,2,3], [4,5,6], [7,8,9]]
     * }
     *
     * Then ziprows(table) is
     * [{a:1,b:2,c:3}, {a:4,b:5,c:6}, {a:7,b:8,c:9}]
     */
    let zipped = [],
        entries = table.columns.map((x) => [x])
    for (let row of table.data) {
        entries.forEach((e, i) => (e[1] = row[i]))
        zipped.push(Object.fromEntries(entries))
    }
    return zipped
}

export function transpose(table, columns, newcols, removeblank = true) {
    /** takes the given columns of the table and transposes them
     *
     * Parameters:
     *      table: the source table
     *      columns: the columns in table to transpose
     *      newcols: the column names to use for the transposed columns
     *      removeblank: leave out blank values in the transpose
     *
     * Returns:
     *      a table with the given columns transposed into 2 columns [colname, colvalue]
     */

    let outcols = []
    for (let c of table.columns) {
        if (columns.indexOf(c) == -1) {
            outcols.push(c)
        }
    }
    let outtable = { columns: [...outcols, ...newcols], data: [] },
        resttable = sql({ select: outcols, from: table }),
        transtable = sql({ select: columns, from: table })

    for (let rowIndex = 0; rowIndex < resttable.data.length; rowIndex++) {
        let r = resttable.data[rowIndex]
        let transrow = transtable.data[rowIndex]
        for (let i = 0; i < columns.length; i++) {
            if (transrow[i] != '' || !removeblank) {
                outtable.data.push([...r, columns[i], transrow[i]])
            }
        }
    }
    return outtable
}

function predicate(where, colnumber) {
    // the where clause is an array [left, op, right]
    // or [function, name, name, name...]
    if (typeof where[0] == 'function') {
        let fn = where[0],
            idx = where.slice(1).map((n) => colnumber[n])
        return function (r) {
            return fn(...idx.map((i) => r[i]))
        }
    }
    let [left, op, right] = where
    left = operand(left, colnumber)
    if (op == 'in') {
        // special case, right is an array & would be misunderstood by
        // operand.
        return (r) => right.indexOf(left(r)) != -1
    }
    right = operand(right, colnumber)
    switch (op) {
        case '==':
        case '=':
            return (r) => left(r) == right(r)
        case '<>':
            return (r) => left(r) != right(r)
        case '<':
            return (r) => left(r) < right(r)
        case '<=':
            return (r) => left(r) <= right(r)
        case '>':
            return (r) => left(r) > right(r)
        case '>=':
            return (r) => left(r) >= right(r)
        case '||':
            return (r) => left(r) || right(r)
        case '&&':
            return (r) => left(r) && right(r)
    }
}

function operand(name, colnumber) {
    if (Array.isArray(name)) {
        return predicate(name, colnumber)
    }
    let i = colnumber[name]
    if (i != undefined) {
        return (r) => r[i]
    }
    return (r) => name
}

function comparison(order, colnumber) {
    // returns a comparison function
    // order can be a string, an array of [string, direction, ?mapfn?], or an array of these
    function compare(x, y) {
        // try various data conversions
        if (x < y) {
            return -1
        }
        if (x > y) {
            return 1
        }
        return 0
    }

    order = [].concat(order).map((c) => (typeof c == 'string' ? { [c]: 'asc' } : c))
    order = order.map(function (c) {
        let [col, direction] = Object.entries(c)[0],
            map = (x) => x
        if (typeof direction == 'function') {
            map = direction
            direction = 1
        } else {
            direction = direction == 'asc' ? 1 : -1
        }
        col = colnumber[col]
        return (rowa, rowb) => direction * compare(map(rowa[col]), map(rowb[col]))
    })

    return function (rowa, rowb) {
        for (let o of order) {
            let v = o(rowa, rowb)
            if (v != 0) {
                return v
            }
        }
        return 0
    }
}

function rowlookup(table, columns) {
    // creates a lookup table based on values in the columns list,
    // provided the column entries are stringifiable
    let colnos = columns.map((c) => table.columns.indexOf(c)),
        rows = Object.create(null)
    for (let row of table.data) {
        let key = JSON.stringify(colnos.map((i) => String(row[i] ?? ''))),
            allrows = rows[key] || []
        allrows.push(row)
        rows[key] = allrows
    }
    return rows
}

export function inner_join(table1, table2, column, column2) {
    // inner join of table1 and table2 where
    // table1[...column]==table2[...(column2||column)]

    // make the columns arrays, in case they are strings
    column = [].concat(column)
    column2 = [].concat(column2 || column)

    // index the columns in the tables
    let col_1 = column.map((c) => table1.columns.indexOf(c)),
        col_2 = column2.map((c) => table2.columns.indexOf(c)),
        lookup2 = rowlookup(table2, column2),
        data = []

    // check for error
    if (col_1.some((i) => i == -1) || col_2.some((i) => i == -1)) {
        throw 'Column missing in one or both tables'
    }

    // join  the rows
    for (let row of table1.data) {
        let table1_key = JSON.stringify(col_1.map((i) => String(row[i] ?? ''))),
            matched_rows = lookup2[table1_key] || []
        for (let entry of matched_rows) {
            // filtering stops duplicated columns
            let joined_row = [...row, ...entry.filter((e, i) => col_2.indexOf(i) == -1)]
            data.push(joined_row)
        }
    }

    // filtering stops duplicated columns
    let columns = [
        ...table1.columns,
        ...table2.columns.filter((e, i) => col_2.indexOf(i) == -1),
    ]
    return { columns, data }
}

export function left_join(table1, table2, column, column2, fillvalue = '') {
    // left outer join - rows retained if in table1

    // make the columns arrays, in case they are strings
    column = [].concat(column)
    column2 = [].concat(column2 || column)

    // index the columns in the tables
    let col_1 = column.map((c) => table1.columns.indexOf(c)),
        col_2 = column2.map((c) => table2.columns.indexOf(c)),
        lookup2 = rowlookup(table2, column2),
        data = [],
        filler = Array(table2.columns.length - col_2.length).fill(fillvalue)

    // check for error
    if (col_1.some((i) => i == -1) || col_2.some((i) => i == -1)) {
        throw 'Column missing in one or both tables'
    }

    for (let row of table1.data) {
        let table1_key = JSON.stringify(col_1.map((i) => String(row[i] ?? ''))),
            matched_rows = lookup2[table1_key] || []
        if (matched_rows.length == 0) {
            let joined_row = [...row, ...filler]
            data.push(joined_row)
        } else {
            for (let entry of matched_rows) {
                let joined_row = [
                    ...row,
                    ...entry.filter((e, i) => col_2.indexOf(i) == -1),
                ]
                data.push(joined_row)
            }
        }
    }
    let columns = [
        ...table1.columns,
        ...table2.columns.filter((e, i) => col_2.indexOf(i) == -1),
    ]
    return { columns, data }
}

