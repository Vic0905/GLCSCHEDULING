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
  let { onrefresh, selectedDate, roomType = 'mtm', defaultRoomFilter = '^(A|B|ST)\\d+$' } = $props()

  // ─────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────
  let dialogEl
  let csvFile = $state(null)
  let csvFileName = $state('')
  let importDate = $state('') // single date — replaces startDate/endDate
  let roomFilterPattern = $state(defaultRoomFilter)
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

    const timeslotMatches = sessions.map((s) => {
      const match = timeslots.find(
        (t) => normTime(t.start) === normTime(s.start) && normTime(t.end) === normTime(s.end)
      )
      return { ...s, timeslot: match || null }
    })
    const unmatchedSessionCount = timeslotMatches.filter((s) => !s.timeslot).length

    const dateStr = `${importDate} 00:00:00`

    // Conflict check: find any dailySchedule records already on this date
    const existing = await pb.collection(COLLECTIONS.schedule).getFullList({
      filter: `date >= "${importDate} 00:00:00" && date <= "${importDate} 23:59:59"`,
      fields: 'room,timeslot',
    })
    const existingSlotSet = new Set(existing.map((s) => `${s.room}-${s.timeslot}`))

    const stats = {
      skippedExisting: 0,
      skippedNoStudent: 0,
      skippedNoSubject: 0,
      skippedNoTeacher: 0,
      skippedNoRoom: 0,
      skippedNoTimeslot: 0,
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

    for (let r = dataStartRow; r < rows.length; r++) {
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

        const studentId = studentsByName.get(normName(studentName))
        if (!studentId) {
          stats.skippedNoStudent++
          stats.missingStudents.add(studentName)
          continue
        }

        const subjectId = subjectsByName.get(normName(subjectName))
        if (!subjectId) {
          stats.skippedNoSubject++
          stats.missingSubjects.add(subjectName || '(blank)')
          continue
        }

        let teacherId = teachersByName.get(normName(teacherName))
        if (!teacherId) teacherId = roomDefaultTeacherId.get(normRoomCode(roomName)) || null
        if (!teacherId) {
          stats.skippedNoTeacher++
          stats.missingTeachers.add(teacherName || '(blank)')
          continue
        }

        const key = `${roomId}-${sess.timeslot.id}`
        if (existingSlotSet.has(key) || plannedSlotSet.has(key)) {
          stats.skippedExisting++
          continue
        }
        plannedSlotSet.add(key)

        toCreate.push({
          room: roomId,
          timeslot: sess.timeslot.id,
          teacher: teacherId,
          student: studentId,
          subject: subjectId,
          date: dateStr,
          // small breadcrumbs kept only for the on-screen preview, stripped before create()
          _roomName: roomName,
          _studentName: studentName,
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
      Student / Subject records.
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
            <div class="stat-title text-xs">Already scheduled</div>
            <div class="stat-value text-xs">{preview.stats.skippedExisting}</div>
          </div>
          <div class="stat py-2">
            <div class="stat-title text-xs">No student match</div>
            <div class="stat-value text-xs">{preview.stats.skippedNoStudent}</div>
          </div>
        </div>

        {#if preview.stats.skippedNoSubject || preview.stats.skippedNoTeacher || preview.stats.skippedNoRoom || preview.unmatchedSessionCount}
          <div class="alert alert-warning text-xs py-2">
            <span>
              {#if preview.unmatchedSessionCount}
                {preview.unmatchedSessionCount} time column(s) in the CSV had no matching timeslot record.
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
              {#if preview.stats.skippedNoTeacher}
                {preview.stats.skippedNoTeacher} cell(s) skipped — teacher not found: {listPreview(
                  preview.stats.missingTeachers
                )}.
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
