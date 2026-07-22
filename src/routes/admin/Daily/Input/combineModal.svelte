<script>
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../lib/Pocketbase.svelte'

  let { onrefresh, selectedDate = new Date().toISOString().split('T')[0] } = $props()

  // ═══════════════════════════════════
  // STATE
  // ═══════════════════════════════════

  // Modal
  let show = $state(false)
  let loading = $state(false)
  let showDeleteConfirm = $state(false)
  let showCustomScheduleConfirm = $state(false)
  let confirmedCustomScheduleName = $state('')
  let displaySub = $state(null)

  // Dropdown data
  let subjects = $state([])
  let students = $state([])
  let teachers = $state([])
  let rooms = $state([])
  let timeslots = $state([])
  let customSchedules = $state([]) // ← NEW

  // Form
  let form = $state({
    mode: 'create',
    id: null,
    subject: null,
    teacher: null,
    room: null,
    timeslot: null,
    date: null,
    customSchedule: null, // ← NEW
  })

  let originalState = $state({ timeslotId: null, roomId: null, date: null })

  // Students
  let searchQuery = $state('')
  let selectedStudents = $state([])
  let filterChanged = $state(false)
  let filterExtended = $state(false)

  // ═══════════════════════════════════
  // BREAK TIME & LUNCH BREAK
  // ═══════════════════════════════════

  const BREAK_SCHEDULES = ['lunch break', 'break time', 'other task']

  let isBreakSchedule = $derived(BREAK_SCHEDULES.includes(form.customSchedule?.name?.toLowerCase().trim()))

  // ═══════════════════════════════════
  // DERIVED
  // ═══════════════════════════════════

  let maxCapacity = $derived(form.room?.maxStudents || 0)
  let currentCount = $derived(selectedStudents.length)
  let isOverCapacity = $derived(maxCapacity > 0 && currentCount > maxCapacity)

  let selectableCustomSchedules = $derived(
    customSchedules.filter((cs) => cs.name?.toLowerCase().trim() !== 'sub class')
  )

  let filteredStudents = $derived.by(() => {
    const query = searchQuery.toLowerCase()

    const latest = new Map()
    for (const s of students) {
      const existing = latest.get(s.englishName)
      if (!existing || s.start > existing.start) {
        latest.set(s.englishName, s)
      }
    }
    let filtered = [...latest.values()]

    return filtered
      .filter((s) => s.englishName?.toLowerCase().includes(query))
      .sort((a, b) => {
        const aSelected = selectedStudents.includes(a.id)
        const bSelected = selectedStudents.includes(b.id)
        return bSelected - aSelected
      })
  })

  // ═══════════════════════════════════
  // API HELPERS
  // ═══════════════════════════════════

  async function logActivity(action, details = {}) {
    try {
      await pb.collection('activityLog').create({
        action: action,
        performedBy: pb.authStore.model?.id,
        targetId: form.id || 'bulk-schedule',
        details: details,
      })
    } catch (err) {
      console.error('Failed to write activity log:', err)
    }
  }

  async function loadDropdowns() {
    try {
      const [subj, stu, teach, room, ts, cs] = await Promise.all([
        // ← cs added
        pb.collection('subject').getFullList({ sort: 'name' }),
        pb.collection('student').getFullList({
          sort: 'englishName',
          filter: `status != "graduated" && start <= "${selectedDate} 23:59:59" && end >= "${selectedDate} 00:00:00"`,
        }),
        pb.collection('teacher').getFullList({
          sort: 'name',
          filter: 'status != "disabled"',
        }),
        pb.collection('roomType').getFullList({ sort: 'name' }),
        pb.collection('timeslot').getFullList({ sort: 'start' }),
        pb.collection('customSchedule').getFullList({ sort: 'name' }), // ← NEW
      ])
      subjects = subj
      students = stu
      teachers = teach
      rooms = room
      timeslots = ts
      customSchedules = cs // ← NEW
    } catch {
      toast.error('Failed to load dropdown options')
    }
  }

  function findById(list, id) {
    return list.find((item) => item.id === id) || null
  }

  function findBreakScheduleId(csIds = []) {
    return csIds.find((id) => {
      const cs = customSchedules.find((c) => c.id === id)
      return cs && BREAK_SCHEDULES.includes(cs.name?.toLowerCase().trim())
    })
  }

  // ═══════════════════════════════════
  // MODAL LIFECYCLE
  // ═══════════════════════════════════

  export async function open(data) {
    show = true
    if (!subjects.length) {
      loading = true
      await loadDropdowns()
      loading = false
    }

    const existing = data.schedule || data.schedules?.[0]

    // `existing.customSchedule` comes from the grid's `expand`, so each
    // entry is already a full customSchedule record ({id, name, color}) —
    // not a bare ID string. The old code did
    //   csIds.find(id => customSchedules.find(c => c.id === id))
    // which compared a string id against a whole object and could never
    // match, so the dropdown never prefilled. Read the objects directly.
    const csList = existing?.customSchedule?.length
      ? existing.customSchedule
      : data.customSchedule
        ? [data.customSchedule]
        : []

    // Find the first custom schedule that IS NOT your background tag
    const displayCs = csList.find((cs) => cs && cs.name?.toLowerCase().trim() !== 'sub class')

    form = {
      mode: data.mode,
      id: existing?.id || null,
      subject: findById(subjects, existing?.subject?.id || data.room?.expand?.subject?.id),
      teacher: findById(teachers, existing?.teacher?.id || data.teacher?.id),
      room: findById(rooms, existing?.roomId || data.room?.id),
      timeslot: findById(timeslots, existing?.timeslotId || data.timeslot?.id),
      date: data.date,
      // Re-resolve against the loaded `customSchedules` dropdown list
      // (rather than using the expanded object as-is) so it's the exact
      // same object instance the <select>'s <option> values are bound to —
      // required for bind:value to show it as selected.
      customSchedule: findById(customSchedules, displayCs?.id) || null,
    }

    originalState = {
      timeslotId: form.timeslot?.id,
      roomId: form.room?.id,
      date: data.date,
    }

    selectedStudents = data.mode === 'edit' && data.schedules ? extractStudentsFromSchedules(data.schedules) : []

    await loadDisplaySub()

    showDeleteConfirm = false
  }

  function close() {
    show = false
    loading = false
    showDeleteConfirm = false
    selectedStudents = []
    searchQuery = ''
    displaySub = null
  }
  function handleCustomScheduleChange() {
    if (form.customSchedule) {
      confirmedCustomScheduleName = form.customSchedule.name
      showCustomScheduleConfirm = true
    }
  }

  // ═══════════════════════════════════
  // CUSTOM SCHEDULE MERGE (preserve tags like "Sub Class")
  // ═══════════════════════════════════

  async function getPreservedNonBreakIds() {
    if (form.mode !== 'edit') return []

    try {
      const records = await pb.collection('dailySchedule').getFullList({
        filter: [
          `timeslot = "${originalState.timeslotId}"`,
          `room = "${originalState.roomId}"`,
          `date >= "${originalState.date} 00:00:00"`,
          `date <= "${originalState.date} 23:59:59"`,
        ].join(' && '),
        fields: 'id,customSchedule',
      })

      const preserved = new Set()
      for (const r of records) {
        for (const csId of r.customSchedule || []) {
          const cs = customSchedules.find((c) => c.id === csId)
          // Only preserve explicit background system tags
          if (cs && cs.name?.toLowerCase().trim() === 'sub class') {
            preserved.add(csId)
          }
        }
      }
      return [...preserved]
    } catch {
      toast.error('Failed to check existing schedule tags')
      return []
    }
  }

  // ═══════════════════════════════════
  // READ-ONLY SUB INFO
  // ═══════════════════════════════════

  async function loadDisplaySub() {
    displaySub = null
    if (form.mode !== 'edit' || !originalState.timeslotId || !originalState.roomId || !originalState.date) return

    try {
      const records = await pb.collection('dailySchedule').getFullList({
        filter: [
          `timeslot = "${originalState.timeslotId}"`,
          `room = "${originalState.roomId}"`,
          `date >= "${originalState.date} 00:00:00"`,
          `date <= "${originalState.date} 23:59:59"`,
        ].join(' && '),
        expand: 'sub',
      })

      const withSub = records.find((r) => r.expand?.sub)
      displaySub = withSub?.expand?.sub || null
    } catch {
      // silent — this is supplementary info, shouldn't block the modal
    }
  }

  // ═══════════════════════════════════
  // STUDENT EXTRACTION
  // ═══════════════════════════════════

  function extractStudentsFromSchedules(schedules) {
    return schedules.flatMap((s) => {
      const getId = (stu) => (typeof stu === 'object' ? stu.id : stu)

      if (Array.isArray(s.students)) {
        return s.students.map((stu) => getId(stu))
      }

      const id = s.student?.id ?? s.student ?? s.studentId
      return id ? [id] : []
    })
  }

  // ═══════════════════════════════════
  // STUDENT SELECTION
  // ═══════════════════════════════════

  function toggleStudent(id) {
    if (selectedStudents.includes(id)) {
      selectedStudents = selectedStudents.filter((sid) => sid !== id)
      return
    }

    if (maxCapacity > 0 && currentCount >= maxCapacity) {
      toast.error(`Room capacity reached (${maxCapacity})`)
      return
    }

    selectedStudents = [...selectedStudents, id]
  }

  // ═══════════════════════════════════
  // VALIDATION
  // ═══════════════════════════════════

  function validateForm() {
    if (isBreakSchedule) {
      if (!form.room || !form.timeslot || !form.teacher)
        return 'Please select a room, timeslot, and teacher for the break'
      return null
    }

    if (!form.subject || !form.teacher || !form.room || !form.timeslot) {
      return 'Please fill all required fields'
    }
    if (selectedStudents.length === 0) {
      return 'Select at least one student'
    }
    return null
  }

  // ═══════════════════════════════════
  // CONFLICT DETECTION
  // ═══════════════════════════════════

  function filterEditModeRecords(records) {
    if (form.mode !== 'edit') return records
    return records.filter((s) => s.room !== originalState.roomId)
  }

  function checkConflictTypes(records) {
    const teacherBusy = records.find((s) => s.teacher === form.teacher.id)
    if (teacherBusy) {
      throw new Error(`Teacher is busy in ${teacherBusy.expand?.room?.name || 'another room'}.`)
    }

    // ← NEW: teacher is already covering someone else's class as a sub
    const teacherSubBusy = records.find((s) => s.sub === form.teacher.id)
    if (teacherSubBusy) {
      throw new Error(
        `Teacher is already subbing for ${teacherSubBusy.expand?.teacher?.name || 'another teacher'} in ${teacherSubBusy.expand?.room?.name || 'another room'}.`
      )
    }

    const roomTaken = records.find(
      (s) => s.room === form.room.id && s.teacher !== form.teacher.id && s.sub !== form.teacher.id
    )
    if (roomTaken) {
      throw new Error(`Room is occupied by another teacher.`)
    }

    const studentBusy = records.find((s) => {
      const sid = typeof s.student === 'object' ? s.student.id : s.student
      return selectedStudents.includes(sid)
    })
    if (studentBusy) {
      throw new Error(`Student already has a class in ${studentBusy.expand?.room?.name}.`)
    }
  }

  async function checkConflicts() {
    const dateStartStr = `${form.date} 00:00:00`
    const dateEndStr = `${form.date} 23:59:59`

    const records = await pb.collection('dailySchedule').getFullList({
      filter: `timeslot = "${form.timeslot.id}" && date >= "${dateStartStr}" && date <= "${dateEndStr}"`,
      expand: 'room,teacher,student,sub',
    })

    const others = filterEditModeRecords(records)
    checkConflictTypes(others)
  }

  // ═══════════════════════════════════
  // SAVE
  // ═══════════════════════════════════

  async function deleteExistingRecords() {
    if (form.mode !== 'edit') return []

    const records = await pb.collection('dailySchedule').getFullList({
      filter: [
        `timeslot = "${originalState.timeslotId}"`,
        `room = "${originalState.roomId}"`,
        `date >= "${originalState.date} 00:00:00"`,
        `date <= "${originalState.date} 23:59:59"`,
      ].join(' && '),
      fields: 'id',
    })

    return records.map((rec) => rec.id)
  }

  async function save() {
    const error = validateForm()
    if (error) return toast.error(error)

    loading = true
    try {
      await checkConflicts()

      // Preserve tags like "Sub Class" that this modal doesn't manage,
      // then merge in the break-type tag currently selected (if any).
      const preservedIds = await getPreservedNonBreakIds()
      const finalCustomSchedule = form.customSchedule?.id ? [...preservedIds, form.customSchedule.id] : preservedIds

      const batch = pb.createBatch()

      if (form.mode === 'edit') {
        const idsToDelete = await deleteExistingRecords()
        idsToDelete.forEach((id) => batch.collection('dailySchedule').delete(id))
      }

      selectedStudents.length
        ? selectedStudents.forEach((studentId) => {
            batch.collection('dailySchedule').create({
              timeslot: isBreakSchedule ? null : form.timeslot.id,
              teacher: isBreakSchedule ? null : form.teacher.id,
              subject: isBreakSchedule ? null : form.subject.id,
              room: isBreakSchedule ? null : form.room.id,
              student: studentId,
              date: `${form.date} 00:00:00.000Z`,
              status: 'draft',
              customSchedule: finalCustomSchedule,
            })
          })
        : batch.collection('dailySchedule').create({
            timeslot: form.timeslot?.id || null,
            teacher: form.teacher?.id || null,
            subject: null,
            room: form.room?.id || null,
            student: null,
            date: `${form.date} 00:00:00.000Z`,
            status: 'draft',
            customSchedule: finalCustomSchedule,
          })

      await batch.send()

      await logActivity(form.mode === 'edit' ? 'update' : 'add', {
        subject: form.subject?.name,
        teacherName: form.teacher?.name,
        roomName: form.room?.name,
        timeslot: form.timeslot ? `${form.timeslot.start} - ${form.timeslot.end}` : null,
        date: form.date,
        customSchedule: form.customSchedule?.name || null, // ← NEW
        students: selectedStudents.map((id) => ({
          id,
          name: students.find((st) => st.id === id)?.englishName || id,
        })),
      })

      toast.success(form.mode === 'edit' ? 'Schedule updated' : 'Schedule created')
      onrefresh?.()
      close()
    } catch (e) {
      toast.error(e.message || 'An error occurred')
    } finally {
      loading = false
    }
  }

  // ═══════════════════════════════════
  // DELETE
  // ═══════════════════════════════════

  async function deleteSchedule() {
    loading = true
    try {
      const records = await pb.collection('dailySchedule').getFullList({
        filter: [
          `timeslot = "${originalState.timeslotId}"`,
          `room = "${originalState.roomId}"`,
          `date >= "${originalState.date} 00:00:00"`,
          `date <= "${originalState.date} 23:59:59"`,
        ].join(' && '),
        fields: 'id',
      })

      if (!records.length) return toast.error('No matching schedule records found')

      const batch = pb.createBatch()
      records.forEach((rec) => batch.collection('dailySchedule').delete(rec.id))
      await batch.send()

      await logActivity('delete', {
        roomName: form.room?.name,
        teacherName: form.teacher?.name,
        timeslot: form.timeslot ? `${form.timeslot.start} - ${form.timeslot.end}` : null,
        date: originalState.date,
        customSchedule: form.customSchedule?.name || null, // ← NEW
        students: selectedStudents.map((id) => ({
          id,
          name: students.find((st) => st.id === id)?.englishName || id,
        })),
      })

      toast.success('Schedule deleted')
      onrefresh?.()
      close()
    } catch (e) {
      toast.error(e.message || 'Failed to delete schedule')
    } finally {
      loading = false
      showDeleteConfirm = false
    }
  }
</script>

{#if show}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-4xl border border-base-300 shadow-2xl">
      <!-- Header -->
      <header class="mb-6 text-center">
        <h3 class="text-xl font-bold">
          {form.mode === 'edit' ? 'Edit' : 'Create'}
          {maxCapacity > 1 ? 'Group' : 'MTM'} Schedule
        </h3>
        <p class="text-xs opacity-60 uppercase tracking-widest">{form.date}</p>
      </header>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
        <!-- Left Column: Schedule Fields -->
        <div class="space-y-4">
          <div class="form-control">
            <label class="label text-xs font-bold" for="subject">Subject</label>
            <select
              id="subject"
              bind:value={form.subject}
              class="select select-bordered select-sm w-full"
              disabled={isBreakSchedule}
            >
              <option value={null}>Select Subject</option>
              {#each subjects as s (s.id)}
                <option value={s}>{s.name}</option>
              {/each}
            </select>
          </div>

          <div class="form-control">
            <label class="label text-xs font-bold" for="teacher">Teacher</label>
            <select id="teacher" bind:value={form.teacher} class="select select-bordered select-sm w-full">
              <option value={null}>Select Teacher</option>
              {#each teachers as t (t.id)}
                <option value={t}>{t.name}</option>
              {/each}
            </select>
          </div>

          <div class="grid grid-cols-2 gap-2">
            <div class="form-control">
              <label class="label text-xs font-bold" for="room">Room</label>
              <select id="room" bind:value={form.room} class="select select-bordered select-sm w-full">
                {#each rooms as r (r.id)}
                  <option value={r}>{r.name}</option>
                {/each}
              </select>
            </div>
            <div class="form-control">
              <label class="label text-xs font-bold" for="timeslot">Timeslot</label>
              <select id="timeslot" bind:value={form.timeslot} class="select select-bordered select-sm w-full">
                {#each timeslots as ts (ts.id)}
                  <option value={ts}>{ts.start} - {ts.end}</option>
                {/each}
              </select>
            </div>
          </div>

          <div class="form-control">
            <label class="label text-xs font-bold" for="customSchedule">
              Custom Schedule <span class="font-normal opacity-50">(optional)</span>
            </label>
            <select
              id="customSchedule"
              bind:value={form.customSchedule}
              onchange={handleCustomScheduleChange}
              class="select select-bordered select-sm w-full"
            >
              <option value={null}>None</option>
              {#each selectableCustomSchedules as cs (cs.id)}
                <option value={cs}>{cs.name}</option>
              {/each}
            </select>

            {#if displaySub}
              <div class="alert alert-info alert-soft text-lg font-bold py-2 mt-2">
                <span>
                  Currently subbed by: <strong>{displaySub.name}</strong>
                </span>
              </div>
            {/if}
          </div>

          {#if isBreakSchedule}
            <div class="alert alert-info alert-soft text-sm py-2">
              <span>Break schedules don't require a subject or students.</span>
            </div>
          {/if}
        </div>
        <!-- END Left Column -->

        <!-- Right Column: Student Selection -->
        <div class="flex flex-col" class:opacity-40={isBreakSchedule} class:pointer-events-none={isBreakSchedule}>
          <div class="flex justify-between items-center mb-2">
            <!-- svelte-ignore a11y_label_has_associated_control -->
            <label class="text-xs font-bold uppercase">Students</label>
            <span class="badge {isOverCapacity ? 'badge-error' : 'badge-ghost'} badge-sm">
              {currentCount} / {maxCapacity || '∞'}
            </span>
          </div>

          <input
            type="text"
            placeholder="Search students..."
            bind:value={searchQuery}
            class="input input-bordered input-sm w-full mb-3"
          />

          <div class="border rounded-lg overflow-y-auto bg-base-200/50 p-2 h-72">
            {#if loading}
              <p class="text-xs opacity-50 p-4 text-center">Loading...</p>
            {:else}
              {#each filteredStudents as s (s.id)}
                {@const isSelected = selectedStudents.includes(s.id)}
                <div class="mb-1 rounded-md {isSelected ? 'bg-base-300/60' : ''}">
                  <label class="flex items-center gap-3 p-2 hover:bg-base-300 rounded-md cursor-pointer">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-primary checkbox-sm"
                      checked={isSelected}
                      onchange={() => toggleStudent(s.id)}
                      disabled={!isSelected && maxCapacity > 0 && currentCount >= maxCapacity}
                    />
                    <span class="text-sm {isSelected ? 'font-bold text-primary' : ''}">
                      {s.englishName}
                    </span>
                    {#if s.status === 'changed'}
                      <span class="badge badge-error badge-xs">changed</span>
                    {:else if s.status === 'extended'}
                      <span class="badge badge-secondary badge-xs">extended</span>
                    {/if}
                  </label>
                </div>
              {:else}
                <p class="text-xs opacity-50 p-4 text-center">No students match your search.</p>
              {/each}
            {/if}
          </div>

          {#if isOverCapacity}
            <p class="text-xs text-error mt-1">Over room capacity ({maxCapacity} max)</p>
          {/if}
        </div>
        <!-- END Right Column -->
      </div>
      <!-- END grid -->

      <!-- Delete Confirmation -->
      {#if showDeleteConfirm}
        <div class="alert alert-soft alert-error mt-6 flex items-center justify-between gap-4">
          <span class="text-sm font-medium">Delete all records for this schedule? This cannot be undone.</span>
          <div class="flex gap-2 shrink-0">
            <button class="btn btn-sm btn-ghost" onclick={() => (showDeleteConfirm = false)} disabled={loading}
              >Cancel</button
            >
            <button class="btn btn-sm btn-ghost" onclick={deleteSchedule} disabled={loading}>
              {#if loading}
                <span class="loading loading-spinner loading-xs"></span>
              {:else}
                Confirm Delete
              {/if}
            </button>
          </div>
        </div>
      {/if}

      <!-- Actions -->
      <div class="modal-action mt-8">
        {#if form.mode === 'edit'}
          <button
            class="btn btn-error btn-soft mr-auto"
            onclick={() => (showDeleteConfirm = true)}
            disabled={loading || showDeleteConfirm}
          >
            Delete Schedule
          </button>
        {/if}
        <button class="btn btn-soft btn-ghost" onclick={close} disabled={loading}>Cancel</button>
        <button class="btn btn-soft btn-info min-w-[140px]" onclick={save} disabled={loading || isOverCapacity}>
          {#if loading}
            <span class="loading loading-spinner"></span>
          {:else}
            Save Schedule
          {/if}
        </button>
      </div>
    </div>
    <div class="modal-backdrop bg-black/40" role="presentation" onclick={close}></div>

    {#if showCustomScheduleConfirm}
      <dialog class="modal modal-open z-[60]">
        <div class="modal-box max-w-sm text-center">
          <h3 class="font-bold text-lg mb-2">Custom Schedule Selected</h3>
          <p class="text-sm opacity-70 mb-4">
            This schedule is now set to <span class="font-semibold">{confirmedCustomScheduleName}</span>.
          </p>
          <div class="modal-action justify-center">
            <button class="btn btn-sm btn-info" onclick={() => (showCustomScheduleConfirm = false)}> Got it </button>
          </div>
        </div>
        <div
          class="modal-backdrop bg-black/40"
          role="presentation"
          onclick={() => (showCustomScheduleConfirm = false)}
        ></div>
      </dialog>
    {/if}
  </dialog>
{/if}
