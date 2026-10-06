import { DBSheet } from './gsheet-db-client.js'
import { sql, values, left_join, ziprows } from './sql.js'
import { Defer, getweeks, getdays, gettimes, localTime } from './utils.js'

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
let selectionVersion = 0
let cancelSelection

// sheet is the object to access the google sheets, using the
// URL of the latest deployment of the "simplesql" g-script
let sheet = new DBSheet(
        'https://script.google.com/macros/s/AKfycbwb69Sg9KSfMOO9L7KstKKF5CKaraYG5jh-SPLUsg96JMuI-CTsWX7IAahux9rJeWSH5Q/exec'
    ),
    // db is the code name of the google sheet to access, which the gscript uses to redirect to the actual sheet
    // (no-one reading this client code can then know what the google sheet is)
    db = new URL(window.location).searchParams.get('db'),
    calendar_promise,
    students_promise,
    sessions_promise,
    classlist_promise, // to be fetched later
    classlist_promise_time,
    // state is used to keep the current state of the query, but could be removed
    state = {
        lesson_name: '',
    },
    // container is the element where the buttons get inserted.
    container = document.getElementById('container')

async function chooseParameter(
    name,
    title,
    src_table,
    table,
    highlight = '',
    mapping = (x) => x,
    cols = 1
) {
    /** check if a specific param is in the query string,
     * and if not, display a set of buttons to select it. The name/value pair is
     * then added to the query string and the cycle starts all over again.
     *
     * Parameters:
     *      name - the name of the param
     *      title - the title of the button array page used to choose the param, if needed
     *      src_table - the table from the spreadsheet to select the param values from
     *      table - (optional) the selection from src_table, if it's already been done. Typically,
     *          table = sql({select:name, from:src-table})
     *      highlight - (optional) which of the buttons to highlight. Useful for date/time choices so the
     *          user doesn't have to figure out which button to press
     *      mapping - (optional) a function which takes param values and turns them into display button values.
     *          This is used mainly for week ids where we display e.g. w1_5 as 1.5
     *      cols - (optional) the number of columns to use when laying out the buttons, either 1 or 3 is standard
     *
     * Returns:
     *      the new query string parameters and a table where the param name has been selected. The return table can
     *      be used as the src_table for the next call
     */
    let url = new URL(window.location),
        params = url.searchParams

    //  query src_table for all distinct values of the the column given by name
    // if table doesn't exist
    table =
        table ||
        sql({
            select: name,
            from: src_table,
            distinct: true,
            order_by: name,
        })

    if (!table.data.length) throw new Error('No available choices for ' + name + '.')
    if (params.has(name) && !values(table).some(value => String(value) === params.get(name))) {
        throw new Error('The selected ' + name + ' is unavailable. Use Back to change the selection.')
    }
    if (!params.get(name)) {
        // the param is not in the query string, so we display buttons to let the user choose it.

        let items = values(table) // table is just 1 column

        if (items.length == 1) {
            // there is only one possible value for the param, so no choice is needed
            params.set(name, items[0])
            window.history.replaceState({}, '', url)
            params = new URL(window.location).searchParams
        } else {
            // create button array

            // change the table entries by the mapping function
            items = items.map(mapping)

            // start the page
            let html = []
            html.push(`<div class=layout${cols}>`)
            // the class of the grid depends on the cols parameter
            html.push(
                `<div class='gridel title' style='grid-column:1/span ${cols}'><h1>${title}</h1></div>`
            )
            for (let item of items) {
                html.push(
                    `<button class="gridel chooser ${
                        (item.label || item) == highlight ? 'highlight' : ''
                    }" id="${escapeHTML(item.value ?? item)}">`
                )
                html.push(escapeHTML(item.label ?? item))
                html.push(`</button>`)
            }
            html.push(`</div>`)
            container.innerHTML = html.join('\n')

            // add callbacks to the buttons which resolve a deferred promise
            // with the new query parameter
            let d = Defer()
            cancelSelection = () => d.reject(new Error('Selection cancelled'))
            for (let elem of document.querySelectorAll('.chooser').values()) {
                elem.onclick = async (evt) => d.resolve(evt.currentTarget.id)
            }
            // we await the promise which is resolved by a button press
            params.set(name, await d)
            cancelSelection = undefined
            window.history.pushState({}, '', url)
        }
    }

    // new_table is usually used in a subsequent chooseParam call
    let new_table = sql({
        select: '*',
        from: src_table,
        where: [name, '=', params.get(name)],
    })

    return [params, new_table]
}

// Cache successful reads for this page, but allow failed reads to be retried.
function readTable(name) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    const promise = sheet.doGet(
        {
            db,
            select: name === 'students' ? ['UB Number', 'First name', 'Last name', 'info'] : '*',
            from: name,
        },
        { signal: controller.signal }
    ).catch(error => {
        if (error.name === 'AbortError') {
            throw new Error('The database took too long to respond. Please retry.')
        }
        throw error
    }).finally(() => clearTimeout(timer))
    // Prefetches may fail while the user is still choosing a lesson.
    promise.catch(() => {})
    return promise
}

export async function run_select() {
    const version = ++selectionVersion
    cancelSelection?.()
    cancelSelection = undefined
    container.textContent = 'Loading sessions…'
    try {
        if (!db) throw new Error('No database selected. Open an attendance link with a db parameter.')
        // Give the first screen priority over the larger student directory.
        sessions_promise ||= readTable('sessions').catch(error => {
            sessions_promise = undefined
            throw error
        })
        // A direct lesson link already identifies the data needed by the register.
        // Start these reads together instead of waiting for the sessions round trip.
        const linkedLesson = new URL(window.location).searchParams.get('Lesson')
        if (linkedLesson) {
            calendar_promise ||= readTable('calendar')
            students_promise ||= readTable('students')
            if (!classlist_promise || state.lesson_name !== linkedLesson) {
                state.lesson_name = linkedLesson
                classlist_promise = readTable(linkedLesson)
                classlist_promise_time = Date.now()
            }
        }
        const sessions = await sessions_promise
        if (version !== selectionVersion) return
        calendar_promise ||= readTable('calendar')
        students_promise ||= readTable('students')
        await selectAttendance(sessions, version)
    } catch (error) {
        if (version !== selectionVersion) return
        calendar_promise = students_promise = undefined
        state.lesson_name = ''
        container.textContent = 'Unable to load attendance: ' + (error.message || String(error))
        const retry = document.createElement('button')
        retry.textContent = 'Retry'
        retry.onclick = run_select
        container.appendChild(retry)
    }
}

async function selectAttendance(global_sessions, version) {
    const checkCurrent = () => {
        if (version !== selectionVersion) throw new Error('Selection cancelled')
    }
    const chooseParam = async (...args) => {
        checkCurrent()
        const result = await chooseParameter(...args)
        checkCurrent()
        return result
    }

    /** run the entire selection process to find the combination of
     * module * lesson * week * day * time * group
     * we want to take attendance for
     */

    let params,
        // copy the global_sessions object
        sessions = sql({ select: '*', from: global_sessions })

    ;[params, sessions] = await chooseParam('Module', 'Choose Module', sessions)
    ;[params, sessions] = await chooseParam('Lesson', 'Choose Lesson', sessions)

    // we now have enough info to choose a class list page
    if (!classlist_promise || state.lesson_name != params.get('Lesson')) {
        // this != test is so that in successive calls to run_select()
        // we only download the classlist_promise once; in a normal run
        // this is not needed but I think it was put in for when you use the
        // back button to choose a new lesson.
        state.lesson_name = params.get('Lesson')
        classlist_promise = readTable(state.lesson_name)
        classlist_promise_time = Date.now()
    }

    // choose the week
    let [weeks, current_week] = getweeks(await calendar_promise, sessions),
        param_mapping = (w) => ({
            value: w,
            label: w.replace('w', '').replace('_', '.'),
        })

    // this chooseParams puts up a 3 column button array to select the
    // correct week
    ;[params, weeks] = await chooseParam(
        'Week',
        'Choose Week',
        weeks, // src_table same as table
        weeks,
        param_mapping(current_week).label, // need to map the current week to highlight it.
        param_mapping,
        3
    )

    // from the above weeks selection, choose all sessions where
    // the selected week has a session
    sessions = sql({
        select: '*',
        from: sessions,
        where: [value => value != null && value !== '', params.get('Week')],
    }) // this semicolon needed to fool the pretty printer

    // choose the lab day
    ;[params, sessions] = await chooseParam(
        'Day',
        'Choose Day',
        sessions,
        ...getdays(sessions)
    )

    // choose the lab time
    ;[params, sessions] = await chooseParam(
        'Time',
        'Choose Time',
        sessions,
        ...gettimes(sessions)
    )

    // choose the lab group (often not needed)
    ;[params, sessions] = await chooseParam('Group', 'Choose Group', sessions)

    // work out the session number
    let session = values(
        sql({
            select: params.get('Week'),
            from: sessions,
        })
    )

    // a session shouldn't be empty, but if so warn user
    if (session.length == 0) {
        container.textContent = `There are no labs scheduled for group ${params.get(
            'Group'
        )} at this time. Use the back button to return to selections.`
        return
    }
    // there shouldn't be more than one session, but if so warn the user
    if (session.length > 1) {
        container.textContent = `There are multiple labs scheduled for group ${params.get(
            'Group'
        )} at this time, so there is a problem with the database. Use the back button to return to selections.`
        return
    }
    // otherwise we pick the first and only session
    session = session[0]
    if (!Number.isSafeInteger(Number(session)) || Number(session) < 1) {
        throw new Error('The selected session number is invalid.')
    }

    // check classlist_promise is not out of date (older than 5 minutes)
    // which might happen if the user is interrupted
    if (Date.now() - classlist_promise_time > 1000 * 60 * 5) {
        classlist_promise = readTable(state.lesson_name)
        classlist_promise_time = Date.now()
    }

    container.textContent = 'Loading class list…'

    // now we can get the class list for this particular lab,
    let classlist = make_classlist(
        await classlist_promise,
        await students_promise,
        session
    )
    checkCurrent()
    // create a zipped table & index
    classlist = ziprows(classlist)

    // the existing field is used by click handlers
    // to record the existing record in the class list
    for (let student of classlist) {
        student.existing = student['session' + session]
    }

    // generate the attendance page from the classlist
    generate_attendance_page(classlist, params, session)
}

function generate_attendance_page(classlist, params, session) {
    /** generates the attendance page and attendant click handlers
     *
     * Parameters:
     *      classlist: an array of student attendance objects
     *      params: the query parameters for the page
     *      session: the actual session number we're taking attendance for.
     *
     *
     */
    function attend_style(student) {
        // works out the style based on item['session'+session]
        let attend = String(student['session' + session] ?? '')
        if (attend.startsWith('AGC')) {
            return ' agc'
        }
        return attend ? ' present' : ''
    }

    function historysymbols(hstr) {
        // converts the history string
        let symbols = ''
        for (let h of hstr) {
            if (h == 'x') {
                symbols += "<span style='color:red'>&#x274C</span>"
            } else if (h === '.') {
                symbols += "<span style='color:lightblue'>&#x2742</span>"
            } else {
                symbols += "<span style='color:green'>&#x2705</span>"
            }
        }
        return symbols
    }

    // create an index by UB number
    let classlist_index = Object.create(null)
    classlist.forEach((c, i) => (classlist_index[c['UB Number']] = classlist[i]))

    let html = []
    html.push('<div class=layout_2>')
    html.push("<div class='gridel title' >")
    html.push(`	<h1>${escapeHTML(params.get('Module'))} Group ${escapeHTML(params.get('Group'))}</h1>`)
    html.push('</div>')
    for (let student of classlist) {
        html.push(
            `<button id="attend_${escapeHTML(student['UB Number'])}" class='gridel leftjust chooser${attend_style(student)}'>`
        )
        html.push(
            `	<div>${escapeHTML(student.fullname)} </div><div style='font-size:6pt'>${historysymbols(
                student.history
            )}</div>`
        )
        html.push('</button>')
        html.push(`<button class=toggledown id="toggle_${escapeHTML(student['UB Number'])}"></button>`)
        // the whole textarea is put in one line so a blank comment doesn't get turned into '\n' when the html array is joined.
        html.push(
            `<textarea id="comment_${escapeHTML(student['UB Number'])}" style='grid-column:1/span 2; width:100%;display:none;resize:vertical;' >` +
                escapeHTML(student['comment' + session]) +
                '</textarea>'
        )
        if (student.info) {
            html.push(
                `<div style='font-size:10pt;grid-column:1/span 2'>${escapeHTML(student.info)}</div>`
            )
        }
    }
    html.push(
        "<button class='gridel' id='register_swap' style='grid-column:1/span 2;'>Register Swap</button>"
    )
    html.push('</div>')
    container.innerHTML = html.join('\n')

    const status = document.createElement('p')
    status.setAttribute('role', 'status')
    container.prepend(status)
    let pending = 0
    const failures = new Map()
    const writes = new Map()
    async function save(UB, fields) {
        const key = UB + ':' + Object.keys(fields).join(',')
        pending++
        status.textContent = `Saving ${pending} change(s)…`
        const previous = writes.get(UB) || Promise.resolve()
        const operation = previous.catch(() => {}).then(async () => {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 30000)
            try {
                const result = await sheet.doGet({
                    db, update: params.get('Lesson'),
                    where: ['UB Number', '=', UB], set: fields,
                }, { signal: controller.signal, cache: 'no-store' })
                if (Array.isArray(result.rows) && result.rows.length === 0) {
                    throw new Error('No matching student record was found.')
                }
                // Force the next visit to read the saved attendance again.
                classlist_promise = undefined
                failures.delete(key)
                return result
            } finally {
                clearTimeout(timer)
            }
        })
        writes.set(UB, operation)
        try {
            return await operation
        } catch (error) {
            classlist_promise = undefined
            failures.set(key, `Save not confirmed for ${UB}: ${error.message || error}. Check the record before retrying.`)
            throw error
        } finally {
            pending--
            if (writes.get(UB) === operation) writes.delete(UB)
            status.textContent = [...failures.values(), pending ? `Saving ${pending} change(s)…` : failures.size ? '' : 'All changes saved.'].filter(Boolean).join(' ')
        }
    }

    function dialogChoice(dialog) {
        return new Promise(resolve => {
            dialog.returnValue = ''
            dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true })
            dialog.showModal()
        })
    }

    // add the event handlers to the page.
    for (let elem of document.querySelectorAll('.chooser').values()) {
        elem.onclick = (evt) => attend_click(evt, evt.currentTarget.id.replace('attend_', ''))
    }
    for (let elem of document.querySelectorAll('.toggledown').values()) {
        elem.onclick = (evt) => toggle_click(evt, evt.currentTarget.id.replace('toggle_', ''))
    }

    async function attend_click(event, UB) {
        const button = event.currentTarget
        const student = classlist_index[UB]
        if (button.disabled) return
        button.disabled = true
        const field = 'session' + session
        const before = student[field] ?? ''
        const comment = document.getElementById('comment_' + UB)
        const toggler = document.getElementById('toggle_' + UB)
        try {
            if (!before || String(before).startsWith('AGC')) {
                student[field] = localTime()
                if (comment.value.trim()) {
                    comment.style.display = 'block'
                    toggler.classList.replace('toggledown', 'toggleup')
                }
            } else {
                if (comment.style.display === 'block') {
                    comment.style.display = 'none'
                    toggler.classList.replace('toggleup', 'toggledown')
                    await saveComment(UB)
                    return
                }
                if (student.existing && before === student.existing) {
                    await dialogChoice(document.getElementById('warning2'))
                    return
                }
                if (await dialogChoice(document.getElementById('warning')) !== 'yes') return
                student[field] = student.existing ?? ''
            }
            paint()
            await save(UB, { [field]: student[field] })
        } catch (error) {
            student[field] = before
            paint()
        } finally {
            button.disabled = false
        }
        function paint() {
            button.classList.remove('present', 'agc')
            const style = attend_style(student).trim()
            if (style) button.classList.add(style)
        }
    }

    const commentSaves = new Map()
    async function saveComment(UB) {
        const comment = document.getElementById('comment_' + UB)
        const student = classlist_index[UB]
        const field = 'comment' + session
        const value = comment.value
        const previous = commentSaves.get(UB)
        if (previous) {
            await previous.catch(() => {})
            return saveComment(UB)
        }
        if ((student[field] ?? '') === value) return
        const operation = save(UB, { [field]: value })
        commentSaves.set(UB, operation)
        try {
            await operation
            student[field] = value
        } finally {
            commentSaves.delete(UB)
        }
    }

    function toggle_click(event, UB) {
        const comment = document.getElementById('comment_' + UB)
        event.currentTarget.classList.toggle('toggledown')
        event.currentTarget.classList.toggle('toggleup')
        comment.style.display = comment.style.display === 'none' ? 'block' : 'none'
        if (comment.style.display === 'none') saveComment(UB).catch(() => {})
    }
    for (const student of classlist) {
        const UB = String(student['UB Number'])
        document.getElementById('comment_' + UB).onchange = () => saveComment(UB).catch(() => {})
    }

    document.getElementById('register_swap').onclick = async event => {
        const button = event.currentTarget
        const input = document.getElementById('swap_ub')
        if (button.disabled) return
        button.disabled = true
        try {
            if (await dialogChoice(document.getElementById('swap')) !== 'ok') return
            const UB = input.value.trim()
            if (!/^\d+$/.test(UB)) {
                status.textContent = 'Enter a valid UB number to register a swap.'
                return
            }
            const fields = {
                ['session' + session]: localTime(),
                ['comment' + session]: 'swapped to ' + params.get('Group'),
            }
            await save(UB, fields)
            if (classlist_index[UB]) {
                Object.assign(classlist_index[UB], fields)
                classlist_index[UB].existing = fields['session' + session]
                const attendee = document.getElementById('attend_' + UB)
                attendee.classList.remove('agc')
                attendee.classList.add('present')
                document.getElementById('comment_' + UB).value = fields['comment' + session]
            }
            input.value = ''
        } catch (error) {
            // save() keeps the failure visible and the input available for correction.
        } finally {
            button.disabled = false
        }
    }
}

function make_classlist(classlist, students, session) {
    /** creates a classlist for a specific lab
     *
     * Parameters:
     *      classlist: a table from the module page giving groups & UB numbers
     *      students: the students sheet from the spreadsheet
     *      session: th4e session data selected by the user
     *
     * Returns:
     *     a classlist table
     */

    // we get all our settings from the URL
    let params = new URL(window.location).searchParams

    // get the group specified in the &Group=xxxx parameter
    classlist = sql({
        select: '*',
        from: classlist,
        where: ['Group', '=', params.get('Group')],
    })

    // join with the students to get names
    classlist = left_join(classlist, students, 'UB Number')

    // order the students by first then second name
    classlist = sql({
        select: '*',
        from: classlist,
        order_by: ['First name', 'Last name'],
    })

    // add fullname (=firstname+lastname), current attendance, attendance history
    // only fullname is used.
    sql({
        update: classlist,
        set: {
            fullname: [(first, last, ub) => [first, last].filter(Boolean).join(' ') || String(ub), 'First name', 'Last name', 'UB Number'],
            history: '',
        },
    })

    // create history string
    function hcode(h) {
        return !h ? 'x' : String(h).startsWith('AGC') ? '.' : 'p'
    }

    const historyColumns = []
    for (let s = 1; s < session; s++) {
        historyColumns.push(classlist.columns.indexOf('session' + s))
    }
    const historyIndex = classlist.columns.indexOf('history')
    for (const row of classlist.data) {
        row[historyIndex] = historyColumns.map(index => hcode(row[index])).join('')
    }

    return classlist
}
