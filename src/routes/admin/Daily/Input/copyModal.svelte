<script>
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../lib/Pocketbase.svelte'

  let { sourceDate, onrefresh, roomType = null } = $props()

  let isOpen = $state(false)
  let isSaving = $state(false)
  let targetStart = $state('')
  let targetEnd = $state('')
  let summary = $state(null) // { created, skipped, graduated }
  let preview = $state(null) // { graduatedStudents, extendedStudents, replacements, sourceSchedules }

  // The "Sub Class" customSchedule record id — resolved lazily and cached.
  // Copied records should never carry forward a sub assignment or this tag.
  let subClassScheduleId = $state(null)

  export function open() {
    targetStart = ''
    targetEnd = ''
    summary = null
    preview = null
    isOpen = true
  }

  export function close() {
    isOpen = false
    preview = null
  }

  /** All dates (YYYY-MM-DD) in [start, end], inclusive. */
  function dateRange(start, end) {
    const dates = []
    const cur = new Date(start)
    const last = new Date(end)
    while (cur <= last) {
      dates.push(cur.toISOString().split('T')[0])
      cur.setDate(cur.getDate() + 1)
    }
    return dates
  }

  /** YYYY-MM-DD part of a PocketBase date string ('' if empty). */
  const dayOf = (v) => v?.split(' ')[0] || ''

  // Identifies "the same student" across records. "Extend" creates a NEW student
  // record that copies the original's linked user, so that's the safest key.
  // Falls back to English Name for older records that have no user.
  function personKey(s) {
    const user = Array.isArray(s.user) ? s.user[0] : s.user
    return user || `name:${(s.englishName || '').toLowerCase()}`
  }

  async function resolveSubClassScheduleId() {
    if (subClassScheduleId !== null) return // already resolved (possibly to '')
    try {
      const customSchedules = await pb.collection('customSchedule').getFullList({ fields: 'id,name' })
      subClassScheduleId = customSchedules.find((cs) => cs.name.toLowerCase().trim() === 'sub class')?.id || ''
    } catch {
      subClassScheduleId = '' // fail safe — nothing will match, so nothing gets stripped by name
    }
  }

  async function previewCopy() {
    if (!targetStart || !targetEnd) return toast.error('Please select a target date range')
    if (targetEnd < targetStart) return toast.error('End date must be on or after start date')
    if (targetStart <= sourceDate && sourceDate <= targetEnd)
      return toast.error('Target range cannot overlap the source date')

    isSaving = true
    preview = null

    try {
      await resolveSubClassScheduleId()

      // Fetch all dailySchedule records on the source date
      const sourceSchedules = await pb.collection('dailySchedule').getFullList({
        filter: [
          `date >= "${sourceDate} 00:00:00" && date <= "${sourceDate} 23:59:59"`,
          roomType ? `room.roomType = "${roomType}"` : null,
        ]
          .filter(Boolean)
          .join(' && '),
        expand: 'teacher,subject,room,timeslot,student',
      })

      if (!sourceSchedules.length) {
        toast.warning('No schedules found on the source date')
        isSaving = false
        return
      }

      // Collect unique student IDs and check for graduates
      const studentIds = [...new Set(sourceSchedules.map((s) => s.expand?.student?.id || s.student).filter(Boolean))]

      const graduatedStudents = []
      const extendedStudents = []
      const replacements = {} // original student id -> id of the extended record that continues them
      if (studentIds.length) {
        const studentRecords = await pb.collection('student').getFullList({
          fields: 'id,englishName,user,start,end',
        })
        const studentMap = new Map(studentRecords.map((s) => [s.id, s]))

        // Group every record by person so an extended student can be found
        const recordsByPerson = new Map()
        for (const r of studentRecords) {
          const key = personKey(r)
          if (!recordsByPerson.has(key)) recordsByPerson.set(key, [])
          recordsByPerson.get(key).push(r)
        }

        // The record that continues this student into the target range, if there is one:
        // same person, still running at the target start, and already started by the target end.
        // If there are several, take the one that ends soonest (the one active right at the target start).
        const findExtension = (student) =>
          (recordsByPerson.get(personKey(student)) || [])
            .filter(
              (r) =>
                r.id !== student.id && dayOf(r.end) >= targetStart && (!dayOf(r.start) || dayOf(r.start) <= targetEnd)
            )
            .sort((a, b) => dayOf(a.end).localeCompare(dayOf(b.end)) || dayOf(b.start).localeCompare(dayOf(a.start)))[0]

        for (const id of studentIds) {
          const student = studentMap.get(id)
          if (!student) continue
          const studentEnd = dayOf(student.end)
          if (studentEnd && studentEnd < targetStart) {
            const extension = findExtension(student)
            if (extension) {
              // Not graduated — they were extended. Their schedules move to the extended record.
              replacements[id] = extension.id
              extendedStudents.push({ id, name: student.englishName, newEnd: dayOf(extension.end) })
            } else {
              graduatedStudents.push({ id, name: student.englishName, end: studentEnd })
            }
          }
        }
      }

      preview = { graduatedStudents, extendedStudents, replacements, sourceSchedules }
    } catch (err) {
      console.error(err)
      toast.error('Failed to load preview')
    } finally {
      isSaving = false
    }
  }

  async function save() {
    if (!preview) return

    isSaving = true
    summary = null

    const { sourceSchedules, replacements } = preview
    const graduatedIds = new Set(preview.graduatedStudents.map((s) => s.id))
    const dates = dateRange(targetStart, targetEnd)

    try {
      await resolveSubClassScheduleId()

      // Fetch all existing dailySchedule records in the target range in one go
      const existingRecords = await pb.collection('dailySchedule').getFullList({
        filter: `date >= "${targetStart} 00:00:00" && date <= "${targetEnd} 23:59:59"`,
        fields: 'date,room,timeslot,student',
      })

      // Conflict key: a student can only be in one class per timeslot per
      // day, so uniqueness is per date+room+timeslot+student — NOT per
      // date+room+timeslot alone (a GRP class legitimately has several
      // students sharing the same room+timeslot, and each needs its own
      // record). Records with no student (e.g. room-level breaks) fall
      // back to date+room+timeslot.
      const conflictKey = (date, roomId, timeslotId, studentId) =>
        studentId ? `${date}|${roomId}|${timeslotId}|${studentId}` : `${date}|${roomId}|${timeslotId}`

      const existingSet = new Set(
        existingRecords.map((r) => conflictKey(r.date?.split(' ')[0], r.room, r.timeslot, r.student))
      )

      let created = 0
      let skipped = 0
      let graduated = 0

      // Collect all records to create first, then send in chunks
      const toCreate = []

      for (const date of dates) {
        for (const src of sourceSchedules) {
          const teacherId = src.expand?.teacher?.id || src.teacher
          const subjectId = src.expand?.subject?.id || src.subject
          const roomId = src.expand?.room?.id || src.room
          const timeslotId = src.expand?.timeslot?.id || src.timeslot
          const sourceStudentId = src.expand?.student?.id || src.student || null
          // An extended student's schedules are copied onto their extended record,
          // so the new record shows up in that student's own schedule view.
          const studentId = sourceStudentId ? replacements[sourceStudentId] || sourceStudentId : null

          // customSchedule is a multi-relation field, so the raw value is
          // an array of ID strings (it isn't in the `expand` above). The
          // old code did `src.customSchedule || null` and then compared
          // that array to `subClassScheduleId` (a single string id) with
          // `===`, which can never be true — an array is never strictly
          // equal to a string. That silently defeated the "drop Sub Class"
          // logic below. Read it as an array and filter it instead.
          const rawCustomScheduleIds = Array.isArray(src.customSchedule)
            ? src.customSchedule
            : src.customSchedule
              ? [src.customSchedule]
              : []
          const isBreak = rawCustomScheduleIds.length > 0 && !subjectId

          if (!isBreak && (!teacherId || !subjectId || !roomId || !timeslotId)) {
            skipped++
            continue
          }

          if (!roomId || !timeslotId) {
            skipped++
            continue
          }

          if (studentId && graduatedIds.has(studentId)) {
            graduated++
            continue
          }

          const key = conflictKey(date, roomId, timeslotId, studentId)
          if (existingSet.has(key)) {
            skipped++
            continue
          }

          // Never carry forward a sub assignment. Drop the "Sub Class" tag
          // too, but keep any other customSchedule tag (e.g. break/lunch).
          const customScheduleIds = subClassScheduleId
            ? rawCustomScheduleIds.filter((id) => id !== subClassScheduleId)
            : rawCustomScheduleIds

          existingSet.add(key) // prevent duplicates within this batch
          toCreate.push({
            date: `${date} 00:00:00`,
            teacher: teacherId,
            subject: subjectId,
            room: roomId,
            timeslot: timeslotId,
            student: studentId,
            status: 'draft',
            customSchedule: customScheduleIds,
            sub: null,
          })
          created++
        }
      }

      // Send in chunks of 50 to stay within PocketBase batch limits
      const CHUNK_SIZE = 5000
      for (let i = 0; i < toCreate.length; i += CHUNK_SIZE) {
        const chunk = toCreate.slice(i, i + CHUNK_SIZE)
        const b = pb.createBatch()
        for (const data of chunk) {
          b.collection('dailySchedule').create(data)
        }
        await b.send()
      }

      // ─── ACTIVITY LOG ───
      try {
        await pb.collection('activityLog').create({
          action: 'copy',
          performedBy: pb.authStore.record?.id,
          targetId: `${targetStart}_${targetEnd}`,
          details: {
            sourceDate: sourceDate,
            rangeStart: targetStart,
            rangeEnd: targetEnd,
            roomType: roomType || 'all',
            count: created,
          },
        })
      } catch (err) {
        console.error('Failed to write activity log:', err)
      }
      // ────────────────────

      summary = { created, skipped, graduated }
      preview = null
      toast.success(`Done — ${created} created, ${skipped} skipped, ${graduated} graduated skipped`)
      onrefresh?.()
    } catch (err) {
      console.error(err)
      toast.error('Failed to copy schedules')
    } finally {
      isSaving = false
    }
  }
</script>

{#if isOpen}
  <div
    class="fixed inset-0 z-40 bg-black/40"
    role="button"
    tabindex="-1"
    onclick={close}
    onkeydown={(e) => e.key === 'Escape' && close()}
  ></div>

  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div class="bg-base-100 rounded-2xl shadow-xl w-full max-w-sm p-6 flex flex-col gap-4">
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-bold">Copy Schedule</h3>
        <button class="btn btn-ghost btn-sm btn-circle" onclick={close}>✕</button>
      </div>

      {#if !preview}
        <!-- ── Step 1: date inputs ── -->
        <div class="text-sm text-base-content/60">
          Copying all schedules from
          <span class="font-semibold text-base-content">{sourceDate}</span>
          to every day in the selected range.
        </div>

        <div class="flex flex-col gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">Target Start</span>
            <input
              type="date"
              class="input input-bordered input-sm"
              bind:value={targetStart}
              min={sourceDate}
              disabled={isSaving}
            />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">Target End</span>
            <input
              type="date"
              class="input input-bordered input-sm"
              bind:value={targetEnd}
              min={targetStart || sourceDate}
              disabled={isSaving}
            />
          </label>
        </div>

        <div class="flex gap-2 justify-end">
          <button class="btn btn-ghost btn-sm" onclick={close} disabled={isSaving}>Cancel</button>
          <button
            class="btn btn-primary btn-sm"
            onclick={previewCopy}
            disabled={isSaving || !targetStart || !targetEnd}
          >
            {#if isSaving}
              <span class="loading loading-spinner loading-xs"></span>
            {/if}
            Preview
          </button>
        </div>
      {:else}
        <!-- ── Step 2: preview ── -->
        <div class="text-sm text-base-content/60">
          Copying <span class="font-semibold text-base-content">{preview.sourceSchedules.length}</span> schedule{preview
            .sourceSchedules.length === 1
            ? ''
            : 's'}
          from <span class="font-semibold text-base-content">{sourceDate}</span>
          into every day from <span class="font-semibold text-base-content">{targetStart}</span>
          to <span class="font-semibold text-base-content">{targetEnd}</span>.
        </div>

        <div class="text-xs text-base-content/50">
          Sub teacher assignments and the "Sub Class" tag are never copied — every copied slot starts as a normal class.
        </div>

        {#if preview.graduatedStudents.length}
          <div class="flex flex-col gap-2">
            <div class="text-sm font-medium text-warning">
              {preview.graduatedStudents.length} graduated student{preview.graduatedStudents.length > 1 ? 's' : ''} will
              be skipped
            </div>
            <div class="rounded-lg bg-base-200 p-3 flex flex-col gap-1 max-h-48 overflow-y-auto">
              {#each preview.graduatedStudents as s}
                <div class="flex justify-between text-xs">
                  <span class="font-medium">{s.name}</span>
                  <span class="text-base-content/50">ended {s.end}</span>
                </div>
              {/each}
            </div>
          </div>
        {:else}
          <div class="text-sm text-success">No graduated students detected — all schedules will be copied.</div>
        {/if}

        {#if preview.extendedStudents.length}
          <div class="flex flex-col gap-2">
            <div class="text-sm font-medium text-info">
              {preview.extendedStudents.length} extended student{preview.extendedStudents.length > 1 ? 's' : ''} will be
              copied to their extended record
            </div>
            <div class="rounded-lg bg-base-200 p-3 flex flex-col gap-1 max-h-48 overflow-y-auto">
              {#each preview.extendedStudents as s}
                <div class="flex justify-between text-xs">
                  <span class="font-medium">{s.name}</span>
                  <span class="text-base-content/50">now ends {s.newEnd}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <div class="flex gap-2 justify-end">
          <button class="btn btn-ghost btn-sm" onclick={() => (preview = null)} disabled={isSaving}>Back</button>
          <button class="btn btn-primary btn-sm" onclick={save} disabled={isSaving}>
            {#if isSaving}
              <span class="loading loading-spinner loading-xs"></span>
            {/if}
            Confirm Copy
          </button>
        </div>
      {/if}

      {#if summary}
        <div class="rounded-lg bg-base-200 p-3 text-sm flex flex-col gap-1">
          <div class="flex justify-between">
            <span class="text-info font-medium">Created</span>
            <span class="font-bold">{summary.created}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-warning font-medium">Skipped</span>
            <span class="font-bold">{summary.skipped}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-error font-medium">Graduated (skipped)</span>
            <span class="font-bold">{summary.graduated}</span>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}
