<script>
  // ─────────────────────────────────────────────
  // ASSUMPTIONS ABOUT YOUR POCKETBASE SCHEMA
  // (adjust the constants below if any of these are wrong)
  // ─────────────────────────────────────────────
  // - Collection 'teacher' with field 'name'
  // - Collection 'student' with field 'englishName'
  // - Collection 'subject' with field 'name'
  // - Collection 'roomType' with field 'name' + relation field 'teacher', filtered by the
  //   `roomType` prop passed into this component (e.g. "mtm" or "grp")
  // - Collection 'timeslot' with text fields 'start' / 'end' (e.g. "8:00", "8:50")
  // - Collection 'dailySchedule' with relation fields room/timeslot/teacher/student/subject
  //   and a single text datetime field 'date' (e.g. "2024-01-01 00:00:00")
  //
  // ─────────────────────────────────────────────
  // CSV LAYOUT — TWO SECTIONS IN ONE FILE
  // ─────────────────────────────────────────────
  // 1) The main grid: one row per room, with Student Name/Subject/Teacher
  //    triplets per session column. For a group/placeholder session, the
  //    Student Name cell holds a label like "GROUP CLASS" or
  //    "SPARTA STUDENTS (TOEIC)" instead of a real student.
  // 2) A roster section further down the SAME file that re-lists real room
  //    codes — this time as a multi-row block per room — with the actual
  //    student name sitting in the exact same session column as the
  //    matching "GROUP CLASS" cell above. That's where the real names for
  //    a group session live.
  //
  // The boundary between the two sections is detected automatically: it's
  // the first row whose room code (matched against your actual `roomType`
  // records) has already been seen once before. Divider rows like
  // "LUNCH TIME" / "BREAK TIME" never match a real room, so they don't
  // trigger this.
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../lib/Pocketbase.svelte'

  const COLLECTIONS = {
    teacher: 'teacher',
    student: 'student',
    subject: 'subject',
    room: 'roomType',
    timeslot: 'timeslot',
    schedule: 'dailySchedule',
  }

  const CREATE_BATCH_SIZE = 8

  // ─────────────────────────────────────────────
  // Props
  // ─────────────────────────────────────────────
  // roomType: which roomType collection records to import into (e.g. "mtm", "grp")
  // defaultRoomFilter: regex pre-filled in the "Room filter" box for this page
  // defaultSpecialNames: comma-separated list pre-filled in the "Group/placeholder
  //   names" box — Student Name values that mean "look up the real roster below"
  //   instead of "this text is a student's name"
  let {
    onrefresh,
    selectedDate,
    roomType = 'mtm',
    defaultRoomFilter = '^(A|B|ST)\\d+$',
    defaultSpecialNames = 'GROUP CLASS, SPARTA STUDENTS (TOEIC), SPARTA STUDENTS (ESL), SPARTA STUDENTS (IELTS), ━, SP CLASS',
  } = $props()

  // ─────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────
  let dialogEl
  let csvFile = $state(null)
  let csvFileName = $state('')
  let importDate = $state('') // single date — replaces startDate/endDate
  let roomFilterPattern = $state(defaultRoomFilter)
  let specialStudentNames = $state(defaultSpecialNames)
  let isProcessing = $state(false)
  let processingLabel = $state('')
  let progress = $state(0)
  let preview = $state(null) // { stats, toCreate, unmatchedSessionCount }
  let importResult = $state(null) // { created, errors }

  // ─────────────────────────────────────────────
  // Public API (bind:this + .open())
  // ─────────────────────────────────────────────
  export function open() {
    csvFile = null
    csvFileName = ''
    importDate = selectedDate || ''
    roomFilterPattern = defaultRoomFilter
    specialStudentNames = defaultSpecialNames
    preview = null
    importResult = null
    progress = 0
    isProcessing = false
    dialogEl?.showModal()
  }

  function close() {
    dialogEl?.close()
  }

  function onFileChange(e) {
    csvFile = e.target.files?.[0] || null
    csvFileName = csvFile?.name || ''
    preview = null
    importResult = null
  }

  // ─────────────────────────────────────────────
  // CSV parsing (handles quoted fields, CRLF/LF)
  // ─────────────────────────────────────────────
  function parseCsv(text) {
    const rows = []
    let row = []
    let field = ''
    let inQuotes = false
    let i = 0
    const len = text.length

    while (i < len) {
      const char = text[i]

      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"'
            i += 2
            continue
          }
          inQuotes = false
          i++
          continue
        }
        field += char
        i++
        continue
      }

      if (char === '"') {
        inQuotes = true
        i++
        continue
      }
      if (char === ',') {
        row.push(field)
        field = ''
        i++
        continue
      }
      if (char === '\r') {
        i++
        continue
      }
      if (char === '\n') {
        row.push(field)
        rows.push(row)
        row = []
        field = ''
        i++
        continue
      }
      field += char
      i++
    }
    if (field.length || row.length) {
      row.push(field)
      rows.push(row)
    }
    return rows
  }

  /**
   * Locates the "Time" header row, extracts every "H:MM-H:MM" session
   * column (Student Name col), and figures out which column holds the
   * room code so the importer isn't hard-coded to one exact layout.
   */
  function detectLayout(rows) {
    const timeRangeRe = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/

    let timeRowIdx = -1
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      if (rows[i]?.some((c) => c.trim().toLowerCase() === 'time')) {
        timeRowIdx = i
        break
      }
    }
    if (timeRowIdx === -1) {
      throw new Error('Could not find the "Time" header row in this CSV.')
    }

    const timeRow = rows[timeRowIdx]
    const sessions = []
    for (let col = 0; col < timeRow.length; col++) {
      const m = timeRangeRe.exec(timeRow[col].trim())
      if (m) sessions.push({ col, start: m[1], end: m[2] })
    }
    if (!sessions.length) {
      throw new Error('No session time columns (e.g. "8:00-8:50") were found.')
    }

    const topRow = rows[Math.max(0, timeRowIdx - 1)] || []
    let roomCol = topRow.findIndex((c) => c.trim().toUpperCase() === 'ROOM')
    if (roomCol === -1) roomCol = 2 // fallback to the known layout

    const dataStartRow = timeRowIdx + 2 // skip the "Student Name/Subject/Teacher" sub-header row

    return { sessions, roomCol, dataStartRow }
  }

  // ─────────────────────────────────────────────
  // Matching helpers
  // ─────────────────────────────────────────────
  function normName(s) {
    return (s || '').trim().toUpperCase().replace(/\s+/g, ' ')
  }

  /**
   * Normalizes a room code for matching by stripping leading zeros from the
   * trailing number, so "G1", "G01", and "G001" are all treated as the same
   * room. Falls back to a plain trimmed/uppercased match for anything that
   * doesn't fit a [letters][digits] shape.
   */
  function normRoomCode(s) {
    const raw = (s || '').trim().toUpperCase()
    const m = /^([A-Z]+)0*(\d+)$/.exec(raw)
    return m ? `${m[1]}${m[2]}` : raw
  }

  function normTime(t) {
    const m = /(\d{1,2}):(\d{2})/.exec(String(t ?? ''))
    if (!m) return null
    return `${parseInt(m[1], 10)}:${m[2]}`
  }

  async function loadReferenceData() {
    const [rooms, timeslots, teachers, students, subjects] = await Promise.all([
      pb.collection(COLLECTIONS.room).getFullList({ filter: `roomType = "${roomType}"`, expand: 'teacher' }),
      pb.collection(COLLECTIONS.timeslot).getFullList({ sort: 'start' }),
      pb.collection(COLLECTIONS.teacher).getFullList({ fields: 'id,name' }),
      pb.collection(COLLECTIONS.student).getFullList({ fields: 'id,englishName' }),
      pb.collection(COLLECTIONS.subject).getFullList({ fields: 'id,name' }),
    ])
    return { rooms, timeslots, teachers, students, subjects }
  }

  /**
   * Finds the row where the "one row per room" grid ends and the group-class
   * roster section begins. The roster section re-uses real room codes as a
   * multi-row block per room, so the first *recognized* room code we see for
   * the second time marks the boundary. Rows whose room text isn't an actual
   * roomType record (LUNCH TIME, BREAK TIME, section dividers, etc.) are
   * ignored — they never trigger the boundary.
   */
  function findGridEndRow(rows, dataStartRow, roomCol, roomsByName) {
    const seenRooms = new Set()
    for (let r = dataStartRow; r < rows.length; r++) {
      const raw = (rows[r]?.[roomCol] || '').trim()
      if (!raw) continue
      const key = normRoomCode(raw)
      if (!roomsByName.has(key)) continue
      if (seenRooms.has(key)) return r
      seenRooms.add(key)
    }
    return rows.length // no roster section found
  }

  /**
   * Builds a lookup of real student names from the roster section, keyed by
   * room + the exact column the student cell sits in (so it lines up with
   * the matching session column in the main grid above).
   */
  function buildRosterLookup(rows, gridEndRow, roomCol, sessions) {
    const rosterByRoomAndCol = new Map() // `${roomKey}-${col}` -> [{ studentName, subject, teacher }]
    for (let r = gridEndRow; r < rows.length; r++) {
      const row = rows[r]
      if (!row) continue
      const roomKey = normRoomCode((row[roomCol] || '').trim())
      if (!roomKey) continue
      for (const sess of sessions) {
        const studentName = (row[sess.col] || '').trim()
        if (!studentName) continue
        const key = `${roomKey}-${sess.col}`
        if (!rosterByRoomAndCol.has(key)) rosterByRoomAndCol.set(key, [])
        rosterByRoomAndCol.get(key).push({
          studentName,
          subject: (row[sess.col + 1] || '').trim(),
          teacher: (row[sess.col + 2] || '').trim(),
        })
      }
    }
    return rosterByRoomAndCol
  }

  /**
   * Parses the CSV + cross-references your PocketBase data, but does NOT
   * write anything. Used for both the preview and as the first step of
   * the real import.
   */
  async function buildPlan() {
    if (!csvFile) throw new Error('Choose a CSV file first.')
    if (!importDate) throw new Error('Pick a date.')

    let roomFilterRe
    try {
      roomFilterRe = new RegExp(roomFilterPattern, 'i')
    } catch {
      throw new Error('That room filter is not a valid regular expression.')
    }

    const text = await csvFile.text()
    const rows = parseCsv(text)
    const { sessions, roomCol, dataStartRow } = detectLayout(rows)

    const { rooms, timeslots, teachers, students, subjects } = await loadReferenceData()

    const roomsByName = new Map(rooms.map((r) => [normRoomCode(r.name), r.id]))
    const roomDefaultTeacherId = new Map(rooms.map((r) => [normRoomCode(r.name), r.expand?.teacher?.id || null]))
    const teachersByName = new Map(teachers.map((t) => [normName(t.name), t.id]))
    const studentsByName = new Map(students.map((s) => [normName(s.englishName), s.id]))
    const subjectsByName = new Map(subjects.map((s) => [normName(s.name), s.id]))

    // Names that mean "this cell isn't a real student — look up the actual
    // students in the roster block further down the sheet instead."
    const specialNames = new Set(
      specialStudentNames
        .split(',')
        .map((n) => normName(n))
        .filter(Boolean)
    )

    const gridEndRow = findGridEndRow(rows, dataStartRow, roomCol, roomsByName)
    const rosterByRoomAndCol = buildRosterLookup(rows, gridEndRow, roomCol, sessions)

    const timeslotMatches = sessions.map((s) => {
      const match = timeslots.find(
        (t) => normTime(t.start) === normTime(s.start) && normTime(t.end) === normTime(s.end)
      )
      return { ...s, timeslot: match || null }
    })
    const unmatchedSessionCount = timeslotMatches.filter((s) => !s.timeslot).length

    const dateStr = `${importDate} 00:00:00`

    // Conflict check: find any dailySchedule records already on this date.
    // Keyed by room+timeslot+student (not just room+timeslot), because a
    // group-class room can legitimately hold many different students in the
    // same room/timeslot at once.
    const existing = await pb.collection(COLLECTIONS.schedule).getFullList({
      filter: `date >= "${importDate} 00:00:00" && date <= "${importDate} 23:59:59"`,
      fields: 'room,timeslot,student',
    })
    const existingSlotSet = new Set(existing.map((s) => `${s.room}-${s.timeslot}-${s.student}`))

    const stats = {
      skippedExisting: 0,
      skippedNoStudent: 0,
      skippedNoSubject: 0,
      skippedNoTeacher: 0,
      skippedNoRoom: 0,
      skippedNoTimeslot: 0,
      groupSessionsFound: 0, // main-grid cells matching a special/group name
      groupSessionsUnresolved: 0, // ...that produced zero real students
      groupStudentsCreated: 0, // real students pulled in from the roster
      missingStudents: new Set(),
      missingSubjects: new Set(),
      missingTeachers: new Set(),
      missingRooms: new Set(),
    }

    const toCreate = []
    const plannedSlotSet = new Set()
    let totalDataRows = 0
    let matchedRoomRows = 0
    const sampleAllRoomCodes = new Set()

    // Shared "resolve subject/teacher, check conflicts, push" used by both
    // the plain-student path and the group-roster expansion path below.
    // Returns true if a record was queued.
    function tryAddRecord({ roomId, roomName, timeslotId, studentName, studentId, subjectName, teacherName }) {
      const subjectId = subjectsByName.get(normName(subjectName))
      if (!subjectId) {
        stats.skippedNoSubject++
        stats.missingSubjects.add(subjectName || '(blank)')
        return false
      }

      let teacherId = teachersByName.get(normName(teacherName))
      if (!teacherId) teacherId = roomDefaultTeacherId.get(normRoomCode(roomName)) || null
      if (!teacherId) {
        stats.skippedNoTeacher++
        stats.missingTeachers.add(teacherName || '(blank)')
        return false
      }

      const key = `${roomId}-${timeslotId}-${studentId}`
      if (existingSlotSet.has(key) || plannedSlotSet.has(key)) {
        stats.skippedExisting++
        return false
      }
      plannedSlotSet.add(key)

      toCreate.push({
        room: roomId,
        timeslot: timeslotId,
        teacher: teacherId,
        student: studentId,
        subject: subjectId,
        date: dateStr,
        // small breadcrumbs kept only for the on-screen preview, stripped before create()
        _roomName: roomName,
        _studentName: studentName,
      })
      return true
    }

    for (let r = dataStartRow; r < gridEndRow; r++) {
      const row = rows[r]
      if (!row || row.length <= roomCol) continue
      const roomName = (row[roomCol] || '').trim()
      if (!roomName) continue

      totalDataRows++
      if (sampleAllRoomCodes.size < 12) sampleAllRoomCodes.add(roomName)

      if (!roomFilterRe.test(roomName)) continue
      matchedRoomRows++

      const roomId = roomsByName.get(normRoomCode(roomName))
      if (!roomId) {
        stats.skippedNoRoom++
        stats.missingRooms.add(roomName)
        continue
      }

      for (const sess of timeslotMatches) {
        const studentName = (row[sess.col] || '').trim()
        if (!studentName) continue // empty cell — nothing scheduled here, not an error

        if (!sess.timeslot) {
          stats.skippedNoTimeslot++
          continue
        }

        const subjectName = (row[sess.col + 1] || '').trim()
        const teacherName = (row[sess.col + 2] || '').trim()

        if (specialNames.has(normName(studentName))) {
          // Group/Sparta/placeholder cell — pull the real students from the
          // roster block for this exact room + session column instead of
          // treating "GROUP CLASS" etc. as a student name.
          stats.groupSessionsFound++
          const roster = rosterByRoomAndCol.get(`${normRoomCode(roomName)}-${sess.col}`) || []
          let createdForThisCell = 0

          for (const entry of roster) {
            if (specialNames.has(normName(entry.studentName))) continue // still unresolved — no real name given below either

            const studentId = studentsByName.get(normName(entry.studentName))
            if (!studentId) {
              stats.skippedNoStudent++
              stats.missingStudents.add(entry.studentName)
              continue
            }

            const added = tryAddRecord({
              roomId,
              roomName,
              timeslotId: sess.timeslot.id,
              studentName: entry.studentName,
              studentId,
              // prefer the roster row's own subject/teacher; fall back to the
              // group cell's, in case the roster row left them blank
              subjectName: entry.subject || subjectName,
              teacherName: entry.teacher || teacherName,
            })
            if (added) createdForThisCell++
          }

          if (createdForThisCell === 0) stats.groupSessionsUnresolved++
          stats.groupStudentsCreated += createdForThisCell
          continue
        }

        const studentId = studentsByName.get(normName(studentName))
        if (!studentId) {
          stats.skippedNoStudent++
          stats.missingStudents.add(studentName)
          continue
        }

        tryAddRecord({
          roomId,
          roomName,
          timeslotId: sess.timeslot.id,
          studentName,
          studentId,
          subjectName,
          teacherName,
        })
      }
    }

    return {
      stats,
      toCreate,
      unmatchedSessionCount,
      totalDataRows,
      matchedRoomRows,
      sampleAllRoomCodes: [...sampleAllRoomCodes],
    }
  }

  // ─────────────────────────────────────────────
  // Actions
  // ─────────────────────────────────────────────
  async function handlePreview() {
    isProcessing = true
    processingLabel = 'Reading CSV…'
    importResult = null
    try {
      preview = await buildPlan()
    } catch (err) {
      console.error(err)
      toast.error(err.message || 'Failed to parse CSV')
      preview = null
    } finally {
      isProcessing = false
    }
  }

  async function handleImport() {
    if (!preview?.toCreate?.length) return

    isProcessing = true
    processingLabel = 'Creating schedules…'
    progress = 0
    const result = { created: 0, errors: [] }
    const records = preview.toCreate

    for (let i = 0; i < records.length; i += CREATE_BATCH_SIZE) {
      const batch = records.slice(i, i + CREATE_BATCH_SIZE)
      const settled = await Promise.allSettled(
        batch.map(({ _roomName, _studentName, ...rec }) =>
          pb.collection(COLLECTIONS.schedule).create({ ...rec, status: 'draft' })
        )
      )
      settled.forEach((res, idx) => {
        if (res.status === 'fulfilled') {
          result.created++
        } else {
          result.errors.push({
            room: batch[idx]._roomName,
            student: batch[idx]._studentName,
            error: res.reason?.message || String(res.reason),
          })
        }
      })
      progress = Math.round(((i + batch.length) / records.length) * 100)
    }

    isProcessing = false
    importResult = result
    preview = null

    if (result.created) {
      toast.success(`Imported ${result.created} schedule${result.created === 1 ? '' : 's'}`)
      onrefresh?.()
    }
    if (result.errors.length) {
      toast.error(`${result.errors.length} record${result.errors.length === 1 ? '' : 's'} failed — see details below`)
    }
  }

  function listPreview(set, max = 12) {
    const arr = [...set]
    if (arr.length <= max) return arr.join(', ')
    return `${arr.slice(0, max).join(', ')} … (+${arr.length - max} more)`
  }
</script>

<dialog bind:this={dialogEl} class="modal">
  <div class="modal-box max-w-2xl">
    <h3 class="font-bold text-lg mb-1">Import Schedule from CSV</h3>
    <p class="text-xs text-neutral-500 mb-4">
      Reads a room/session grid CSV (room rows × time-slot columns). Skips any cell with no student name, any cell whose
      room/timeslot already has a schedule on the chosen date, and any name it can't match against your Teacher /
      Student / Subject records. Cells matching a "group/placeholder name" below are expanded using the roster block
      elsewhere in the same file instead of being skipped.
    </p>

    {#if !preview && !importResult}
      <div class="form-control gap-3">
        <div>
          <label class="label" for="import-csv-file"><span class="label-text">CSV file</span></label>
          <input
            id="import-csv-file"
            type="file"
            accept=".csv,text/csv"
            class="file-input file-input-bordered file-input-sm w-full"
            onchange={onFileChange}
            disabled={isProcessing}
          />
          {#if csvFileName}
            <span class="text-xs text-neutral-500">Selected: {csvFileName}</span>
          {/if}
        </div>

        <div>
          <label class="label" for="import-date"><span class="label-text">Date</span></label>
          <input
            id="import-date"
            type="date"
            class="input input-bordered input-sm w-full"
            bind:value={importDate}
            disabled={isProcessing}
          />
        </div>

        <div>
          <label class="label" for="import-room-filter"><span class="label-text">Room filter (regex)</span></label>
          <input
            id="import-room-filter"
            type="text"
            class="input input-bordered input-sm w-full font-mono"
            bind:value={roomFilterPattern}
            disabled={isProcessing}
          />
          <span class="text-xs text-neutral-500">Edit if this CSV uses different room codes.</span>
        </div>

        <div>
          <label class="label" for="import-special-names">
            <span class="label-text">Group/placeholder names (comma-separated)</span>
          </label>
          <textarea
            id="import-special-names"
            class="textarea textarea-bordered textarea-sm w-full font-mono"
            rows="2"
            bind:value={specialStudentNames}
            disabled={isProcessing}
          ></textarea>
          <span class="text-xs text-neutral-500">
            When a session's Student Name cell exactly matches one of these, the importer looks for the real students in
            the roster block further down the sheet (same room, same session column) instead of treating this text as a
            student name.
          </span>
        </div>
      </div>

      <div class="modal-action">
        <button class="btn btn-sm" onclick={close} disabled={isProcessing}>Cancel</button>
        <button class="btn btn-primary btn-sm" onclick={handlePreview} disabled={isProcessing || !csvFile}>
          {#if isProcessing}<span class="loading loading-spinner loading-xs"></span>{/if}
          Preview
        </button>
      </div>
    {/if}

    {#if isProcessing}
      <div class="my-4">
        <p class="text-sm mb-1">{processingLabel}</p>
        {#if progress > 0}
          <progress class="progress progress-primary w-full" value={progress} max="100"></progress>
        {/if}
      </div>
    {/if}

    {#if preview && !isProcessing}
      <div class="my-4 space-y-2 text-sm">
        {#if preview.matchedRoomRows === 0}
          <div class="alert alert-error text-xs py-2">
            <span>
              {#if preview.totalDataRows === 0}
                No room codes were found in this CSV's room column — the layout may not match what this importer expects
                (couldn't locate data rows correctly).
              {:else}
                Your room filter <code>{roomFilterPattern}</code> matched none of the {preview.totalDataRows} room code(s)
                in this CSV. That's why every count below is 0. Codes actually found:
                {listPreview(new Set(preview.sampleAllRoomCodes), 12)}. Fix the "Room filter" box above to match these
                and preview again.
              {/if}
            </span>
          </div>
        {/if}

        <div class="stats stats-vertical sm:stats-horizontal shadow w-full text-xs">
          <div class="stat py-2">
            <div class="stat-title text-xs">Will create</div>
            <div class="stat-value text-success text-2xl">{preview.toCreate.length}</div>
          </div>
          <div class="stat py-2">
            <div class="stat-title text-xs">From group cells</div>
            <div class="stat-value text-xs">
              {preview.stats.groupStudentsCreated} student{preview.stats.groupStudentsCreated === 1 ? '' : 's'} / {preview
                .stats.groupSessionsFound} cell{preview.stats.groupSessionsFound === 1 ? '' : 's'}
            </div>
          </div>
          <div class="stat py-2">
            <div class="stat-title text-xs">Already scheduled</div>
            <div class="stat-value text-xs">{preview.stats.skippedExisting}</div>
          </div>
          <div class="stat py-2">
            <div class="stat-title text-xs">No student match</div>
            <div class="stat-value text-xs">{preview.stats.skippedNoStudent}</div>
          </div>
        </div>

        {#if preview.stats.skippedNoSubject || preview.stats.skippedNoTeacher || preview.stats.skippedNoRoom || preview.stats.groupSessionsUnresolved || preview.unmatchedSessionCount}
          <div class="alert alert-warning text-xs py-2">
            <span>
              {#if preview.unmatchedSessionCount}
                {preview.unmatchedSessionCount} time column(s) in the CSV had no matching timeslot record.
              {/if}
              {#if preview.stats.groupSessionsUnresolved}
                {preview.stats.groupSessionsUnresolved} group cell(s) had no usable roster entries below them (nothing to
                import for those).
              {/if}
              {#if preview.stats.skippedNoRoom}
                {preview.stats.skippedNoRoom} cell(s) skipped — room not found: {listPreview(
                  preview.stats.missingRooms
                )}.
              {/if}
              {#if preview.stats.skippedNoSubject}
                {preview.stats.skippedNoSubject} cell(s) skipped — subject not found: {listPreview(
                  preview.stats.missingSubjects
                )}.
              {/if}
              {#if preview.stats.missingTeachers.size}
                <details class="text-xs">
                  <summary class="cursor-pointer text-neutral-500">
                    {preview.stats.missingTeachers.size} unmatched teacher name(s) — click to view
                  </summary>
                  <p class="mt-1 text-neutral-600">
                    {listPreview(preview.stats.missingTeachers, preview.stats.missingTeachers.size)}
                  </p>
                </details>
              {/if}
            </span>
          </div>
        {/if}

        {#if preview.stats.missingStudents.size}
          <details class="text-xs">
            <summary class="cursor-pointer text-neutral-500">
              {preview.stats.missingStudents.size} unmatched student name(s) — click to view
            </summary>
            <p class="mt-1 text-neutral-600">
              {listPreview(preview.stats.missingStudents, preview.stats.missingStudents.size)}
            </p>
          </details>
        {/if}
      </div>

      <div class="modal-action">
        <button class="btn btn-sm" onclick={() => (preview = null)}>Back</button>
        <button class="btn btn-primary btn-sm" onclick={handleImport} disabled={!preview.toCreate.length}>
          Import {preview.toCreate.length} schedule{preview.toCreate.length === 1 ? '' : 's'}
        </button>
      </div>
    {/if}

    {#if importResult && !isProcessing}
      <div class="my-4 space-y-2 text-sm">
        <div class="alert alert-success text-xs py-2">
          Created {importResult.created} schedule{importResult.created === 1 ? '' : 's'}.
        </div>
        {#if importResult.errors.length}
          <details class="text-xs" open>
            <summary class="cursor-pointer text-error">{importResult.errors.length} failed — click to view</summary>
            <ul class="mt-1 max-h-40 overflow-auto">
              {#each importResult.errors as e}
                <li>{e.room} / {e.student}: {e.error}</li>
              {/each}
            </ul>
          </details>
        {/if}
      </div>

      <div class="modal-action">
        <button class="btn btn-sm" onclick={close}>Close</button>
      </div>
    {/if}
  </div>
  <form method="dialog" class="modal-backdrop"><button>close</button></form>
</dialog>
