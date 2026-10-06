import { sql, values } from './sql.js'

export function Defer() {
    // creates a self-resolvable promise
    let resolve,
        reject,
        p = new Promise((...args) => ([resolve, reject] = args))
    return Object.assign(p, { resolve, reject })
}

export function addTime(date, { y, mo, d, h, m, s }) {
    // adds an interval of time to the date & returns
    let newdate = new Date(date)
    y && newdate.setFullYear(newdate.getFullYear() + y)
    mo && newdate.setMonth(newdate.getMonth() + mo)
    d && newdate.setDate(newdate.getDate() + d)
    h && newdate.setHours(newdate.getHours() + h)
    m && newdate.setMinutes(newdate.getMinutes() + m)
    s && newdate.setSeconds(newdate.getSeconds() + s)
    return newdate
}

export function localTime() {
    // returns a string giving the local time
    let now = new Date()
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
    return date + ' ' + now.toTimeString().slice(0, 8)
}

export function getweeks(calendar, sessions) {
    /**  finds the week ids where there are sessions running
     * 
     * Parameters:
     *      calendar: a table from the calendar page in the spreadsheet, used
     *              to get the week ids (w1_1, w1_2, ...)
     *      sessions: a table from the sessions page in the spreadsheet. This is already
     *              filtered to include just the rows relating to the lesson.
     * 
     * Returns:
     *      [weeks, current_week] where weeks is an array of week ids for which
     *      there are sessions and current_week is the week id for this week if
     *      it's in weeks, otherwise ''
    */

    // params is the webpage's query parameters
    let params = new URL(window.location).searchParams,
        now = new Date(),
        // we can set &year=nnnn in the query string if we want to test the program
        current_year = params.get('year') || String(now.getFullYear()),
        // weeks is the column of week id's for the current year
        weeks = sql({
            select: 'Week',
            from: calendar,
            where: ['year', '=', current_year],
        }),
        // sess is the sessions for the week ids, 
        // where the sessions are replaced with a count of
        // the number of sessions available.
        sess = sql({
            select: values(weeks),
            from: sessions,
            aggregate: function count_non_blanks(col) {
                let count = 0
                for (let c of col) {
                    if (c != null && c !== '') count++
                }
                return count
            },
        })

    // we want to include just the weeks where sess for that week is nonzero
    function some_sessions(wk) {
        // wk is a week id e.g. w1_11
        // select the week from sess
        let s = values(sql({ select: wk, from: sess }))
        // values is [count], return if count is >0 (i.e. some sessions)
        return s[0] > 0
    }
    weeks = sql({ select: '*', from: weeks, where: [some_sessions, 'Week'] })

    // work out the current week
    let in_week = (w) => {
        // true if now is in the week beginning with wb
        w = new Date(w)
        // we is week-ends date
        let w_end = addTime(w, { d: 7 })
        return w <= now && now < w_end // include the whole final day
    },
        curr_week = sql({
            select: 'Week',
            from: calendar,
            where: [in_week, 'begins'],
        })

    return [weeks, (curr_week.data.length>0 && curr_week.data[0][0]) || '']
}

export function getdays(sessions) {
    /** returns the available day names of the sessions
     *  and the current day 
     */
    let daynames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        now = new Date()

    function daymap(d) {
        return daynames.indexOf(d)
    }

    return [
        sql({
            select: 'Day',
            from: sessions,
            distinct: true,
            order_by: { Day: daymap },
        }),
        daynames[now.getDay()],
    ]
}

export function gettimes(sessions) {
    /** returns the available times of the sessions array and
     * the one which most closely matches the current time
     */
    let params = new URL(window.location).searchParams,
        now = new Date(),
        current_time = now.getHours() + (now.getMinutes() > 50 ? 1 : 0)

    return [
        sql({
            select: 'Time',
            from: sessions,
            where: [params.get('Week'), '<>', ''],
            distinct: true,
        }),
        ('0' + current_time).slice(-2) + ':00',
    ]
}

export function selected_date(calendar) {
    // works out the date that was selected in params
    let params = new URL(window.location).searchParams,
        chosen_date = new Date(
            values(
                sql({
                    select: 'begins',
                    from: calendar,
                    where: [(week, year) => week === params.get('Week') && String(year) === (params.get('year') || String(new Date().getFullYear())), 'Week', 'year'],
                })
            )[0]
        )

    let daynames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    chosen_date.setDate(chosen_date.getDate() + daynames.indexOf(params.get('Day')))
    return chosen_date
}
