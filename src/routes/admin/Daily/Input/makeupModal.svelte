<script>
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../lib/Pocketbase.svelte'

  let { onrefresh } = $props()

  // ═══════════════════════════════════
  // STATE
  // ═══════════════════════════════════

  let show = $state(false)
  let loading = $state(false) // dropdown-data load / saving / deleting
  let scheduleLoading = $state(false) // fetching the teacher+timeslot schedule

  let teachers = $state([])
  let timeslots = $state([])
  let selectedTeacher = $state(null)
  let selectedTimeslot = $state(null)
  let teacherRoomMap = new Map() // teacherId -> default room; seeded in open()

  let displayDate = $state(null)
  let displayRoom = $state(null) // resolved room: existing class's room, or teacher's default
  let occupiedByOther = $state(false) // slot has a non-makeup class booked already

  let availableRooms = $state([])
  let selectedRoom = $state(null) // manual pick when no default room exists
  let effectiveRoom = $derived(displayRoom || selectedRoom)

  let subjects = $state([])
  let students = $state([])
  let makeupSchedule = $state(null) // the "Make-up Class" customSchedule record

  let selectedSubject = $state(null)
  let selectedStudents = $state([])

  let existingSchedules = $state([]) // [{id, studentId}] of the current make-up class, if any
  let isEditMode = $state(false)

  let confirmingAction = $state(false)
  let actionType = $state(null) // 'save' | 'delete'

  let searchQuery = $state('')

  // ═══════════════════════════════════
  // DERIVED
  // ═══════════════════════════════════

  let maxCapacity = $derived(effectiveRoom?.maxStudents || 0)
  let currentCount = $derived(selectedStudents.length)
  let isOverCapacity = $derived(maxCapacity > 0 && currentCount > maxCapacity)
  let formReady = $derived(!!selectedTeacher && !!selectedTimeslot && !scheduleLoading && !occupiedByOther)

  let filteredStudents = $derived.by(() => {
    const query = searchQuery.toLowerCase()

    // "Latest record per student" dedup, same as the class modal
    const latest = new Map()
    for (const s of students) {
      const existing = latest.get(s.englishName)
      if (!existing || s.start > existing.start) latest.set(s.englishName, s)
    }

    return [...latest.values()]
      .filter((s) => s.englishName?.toLowerCase().includes(query))
      .sort((a, b) => selectedStudents.includes(b.id) - selectedStudents.includes(a.id))
  })

  // ═══════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════

  function normalizeSchedules(rawSchedules) {
    return rawSchedules.map((s) => ({
      id: s.id,
      room: s.expand?.room || null,
      students: s.expand?.student ? [{ id: s.expand.student.id, name: s.expand.student.englishName }] : [],
      subject: s.expand?.subject,
      customSchedule: s.expand?.customSchedule || [],
    }))
  }

  function isMakeupTagged(record) {
    return (record.customSchedule || []).some((cs) => cs.name?.toLowerCase().trim() === 'make-up class')
  }

  // Resolves create vs. edit mode from a fresh set of dailySchedule
  // records for the current teacher+timeslot. Used both for the initial
  // fetch and for reloading after a save/delete.
  function applyScheduleRecords(records) {
    const normalized = normalizeSchedules(records)
    const makeup = normalized.filter(isMakeupTagged)

    occupiedByOther = normalized.some((r) => !isMakeupTagged(r))
    existingSchedules = makeup.map((s) => ({ id: s.id, studentId: s.students?.[0]?.id })).filter((s) => s.studentId)
    isEditMode = existingSchedules.length > 0
    selectedRoom = null

    if (isEditMode) {
      displayRoom = makeup[0]?.room || null
      selectedSubject = subjects.find((s) => s.id === makeup[0]?.subject?.id) || null
      selectedStudents = existingSchedules.map((s) => s.studentId)
    } else {
      displayRoom = teacherRoomMap.get(selectedTeacher?.id) || null
      selectedSubject = null
      selectedStudents = []
    }
  }

  // ═══════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════

  async function loadData() {
    try {
      const [subj, stu, cs, rooms] = await Promise.all([
        pb.collection('subject').getFullList({ sort: 'name' }),
        pb.collection('student').getFullList({
          sort: 'englishName',
          filter: `status != "graduated" && start <= "${displayDate} 23:59:59" && end >= "${displayDate} 00:00:00"`,
        }),
        pb.collection('customSchedule').getFullList({ sort: 'name' }),
        pb.collection('roomType').getFullList({ sort: 'roomType,name' }),
      ])
      subjects = subj
      students = stu
      makeupSchedule = cs.find((c) => c.name.toLowerCase().trim() === 'make-up class') || null
      availableRooms = rooms
    } catch {
      toast.error('Failed to load dropdown data')
    }
  }

  // Fetches whatever's scheduled for the current teacher+timeslot+date
  // and resolves create vs. edit mode. Runs whenever both teacher and
  // timeslot are selected — see the $effect below.
  async function loadScheduleForSelection() {
    scheduleLoading = true
    try {
      const records = await pb.collection('dailySchedule').getFullList({
        filter: `date >= "${displayDate} 00:00:00" && date <= "${displayDate} 23:59:59" && teacher = "${selectedTeacher.id}" && timeslot = "${selectedTimeslot.id}"`,
        expand: 'student,subject,room,customSchedule',
      })
      applyScheduleRecords(records)
    } catch {
      toast.error('Failed to load schedule for this teacher/timeslot')
    } finally {
      scheduleLoading = false
    }
  }

  // ═══════════════════════════════════
  // REACTIVITY
  // ═══════════════════════════════════

  $effect(() => {
    if (show && selectedTeacher && selectedTimeslot) {
      loadScheduleForSelection()
    } else if (show) {
      existingSchedules = []
      isEditMode = false
      occupiedByOther = false
      displayRoom = null
      selectedRoom = null
      selectedSubject = null
      selectedStudents = []
    }
  })

  // ═══════════════════════════════════
  // MODAL LIFECYCLE
  // ═══════════════════════════════════

  // data: { date, teachers, timeslots, teacherRoomMap } — user picks the
  // teacher/timeslot inside the modal (opened via the "+ Make-up Class"
  // button).
  export async function open(data) {
    show = true
    loading = true
    confirmingAction = false
    actionType = null
    displayDate = data.date || null
    searchQuery = ''
    selectedRoom = null
    displayRoom = null
    existingSchedules = []
    isEditMode = false
    occupiedByOther = false
    selectedSubject = null
    selectedStudents = []

    teachers = (data.teachers || []).filter((t) => t.status !== 'disabled')
    timeslots = data.timeslots || []
    teacherRoomMap = data.teacherRoomMap || new Map()

    await loadData()

    // Setting these (after subjects/students are loaded) triggers the
    // $effect above, which fetches the schedule.
    selectedTeacher = null
    selectedTimeslot = null

    loading = false
  }

  function close() {
    show = false
    loading = false
    scheduleLoading = false
    confirmingAction = false
    actionType = null
    teachers = []
    timeslots = []
    selectedTeacher = null
    selectedTimeslot = null
    teacherRoomMap = new Map()
    displayDate = null
    displayRoom = null
    occupiedByOther = false
    selectedSubject = null
    selectedStudents = []
    existingSchedules = []
    isEditMode = false
    searchQuery = ''
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
    if (!selectedTeacher || !selectedTimeslot) return 'Please select a teacher and timeslot'
    if (occupiedByOther) return 'This teacher already has a class at this timeslot'
    if (!effectiveRoom) return 'Please select a room'
    if (!selectedSubject) return 'Please select a subject'
    if (selectedStudents.length === 0) return 'Select at least one student'
    if (!makeupSchedule) return 'No "Make-up Class" custom schedule found'
    return null
  }

  // ═══════════════════════════════════
  // CONFLICT DETECTION
  // ═══════════════════════════════════

  async function checkConflicts() {
    const excludeIds = existingSchedules.map((s) => s.id)

    const records = await pb.collection('dailySchedule').getFullList({
      filter: `timeslot = "${selectedTimeslot.id}" && date >= "${displayDate} 00:00:00" && date <= "${displayDate} 23:59:59"`,
      expand: 'room,teacher,student,sub',
    })
    const relevant = records.filter((r) => !excludeIds.includes(r.id))

    const teacherBusy = relevant.find((s) => s.teacher === selectedTeacher.id || s.sub === selectedTeacher.id)
    if (teacherBusy) throw new Error('Teacher is no longer free for this timeslot.')

    const roomTaken = relevant.find((s) => s.room === effectiveRoom.id)
    if (roomTaken) throw new Error('Room is already occupied for this timeslot.')

    const studentBusy = relevant.find((s) => {
      const sid = typeof s.student === 'object' ? s.student?.id : s.student
      return selectedStudents.includes(sid)
    })
    if (studentBusy) {
      throw new Error(`Student already has a class in ${studentBusy.expand?.room?.name || 'another room'}.`)
    }
  }

  // ═══════════════════════════════════
  // CONFIRMATION
  // ═══════════════════════════════════

  function requestSave() {
    const error = validateForm()
    if (error) return toast.error(error)
    actionType = 'save'
    confirmingAction = true
  }

  function requestDelete() {
    if (!existingSchedules.length) return
    actionType = 'delete'
    confirmingAction = true
  }

  function cancelConfirm() {
    confirmingAction = false
    actionType = null
  }

  async function confirmAction() {
    const success = actionType === 'delete' ? await deleteAll() : await save()
    confirmingAction = false
    actionType = null
    if (success) await afterActionReset()
  }

  // Keeps the modal open after a successful save/delete, clearing the
  // teacher/timeslot pick so another one can be made right away.
  async function afterActionReset() {
    searchQuery = ''
    selectedTeacher = null
    selectedTimeslot = null
  }

  // ═══════════════════════════════════
  // SAVE / DELETE — return true/false, never close the modal
  // ═══════════════════════════════════

  async function save() {
    const error = validateForm()
    if (error) {
      toast.error(error)
      return false
    }

    loading = true
    try {
      await checkConflicts()

      const existingStudentIds = existingSchedules.map((s) => s.studentId)
      const toCreate = selectedStudents.filter((id) => !existingStudentIds.includes(id))
      const toDelete = existingSchedules.filter((s) => !selectedStudents.includes(s.studentId))
      const toKeep = existingSchedules.filter((s) => selectedStudents.includes(s.studentId))

      const batch = pb.createBatch()

      toCreate.forEach((studentId) => {
        batch.collection('dailySchedule').create({
          teacher: selectedTeacher.id,
          room: effectiveRoom.id,
          timeslot: selectedTimeslot.id,
          subject: selectedSubject.id,
          student: studentId,
          date: `${displayDate} 00:00:00.000Z`,
          status: 'draft',
          customSchedule: [makeupSchedule.id],
        })
      })
      toDelete.forEach((s) => batch.collection('dailySchedule').delete(s.id))
      toKeep.forEach((s) => batch.collection('dailySchedule').update(s.id, { subject: selectedSubject.id }))

      await batch.send()

      try {
        await pb.collection('activityLog').create({
          action: isEditMode ? 'makeup_edit' : 'makeup',
          performedBy: pb.authStore.record?.id,
          details: {
            date: displayDate,
            timeslot: `${selectedTimeslot.start} - ${selectedTimeslot.end}`,
            roomName: effectiveRoom?.name,
            teacherName: selectedTeacher?.name,
            subjectName: selectedSubject?.name,
            students: selectedStudents.map((id) => ({
              id,
              name: students.find((s) => s.id === id)?.englishName || id,
            })),
          },
        })
      } catch (logErr) {
        console.error('Activity log failed:', logErr)
      }

      toast.success(
        isEditMode
          ? 'Make-up class updated'
          : `Make-up class created for ${selectedStudents.length} student${selectedStudents.length === 1 ? '' : 's'}`
      )
      onrefresh?.()
      return true
    } catch (e) {
      toast.error(e.message || 'Failed to save')
      return false
    } finally {
      loading = false
    }
  }

  async function deleteAll() {
    if (!existingSchedules.length) return false

    loading = true
    try {
      const batch = pb.createBatch()
      existingSchedules.forEach((s) => batch.collection('dailySchedule').delete(s.id))
      await batch.send()

      try {
        await pb.collection('activityLog').create({
          action: 'makeup_delete',
          performedBy: pb.authStore.record?.id,
          details: {
            date: displayDate,
            timeslot: `${selectedTimeslot.start} - ${selectedTimeslot.end}`,
            roomName: effectiveRoom?.name,
            teacherName: selectedTeacher?.name,
            subjectName: selectedSubject?.name,
            students: existingSchedules.map((s) => ({
              id: s.studentId,
              name: students.find((st) => st.id === s.studentId)?.englishName || s.studentId,
            })),
          },
        })
      } catch (logErr) {
        console.error('Activity log failed:', logErr)
      }

      toast.success('Make-up class deleted')
      onrefresh?.()
      return true
    } catch (e) {
      toast.error(e.message || 'Failed to delete')
      return false
    } finally {
      loading = false
    }
  }
</script>

{#if show}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-3xl border border-base-300 shadow-2xl">
      <header class="mb-6 text-center">
        <h3 class="text-xl font-bold">{isEditMode ? 'Edit Make-up Class' : 'Make-up Class'}</h3>
        <p class="text-xs uppercase tracking-widest">{displayDate}</p>
      </header>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
        <!-- Left Column -->
        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div class="form-control">
              <label class="label text-xs font-bold uppercase" for="mk-teacher-select">Teacher</label>
              <select
                id="mk-teacher-select"
                class="select select-bordered select-sm w-full"
                bind:value={selectedTeacher}
                disabled={loading || confirmingAction}
              >
                <option value={null}>Select Teacher</option>
                {#each teachers as t (t.id)}
                  <option value={t}>{t.name}</option>
                {/each}
              </select>
            </div>
            <div class="form-control">
              <label class="label text-xs font-bold uppercase" for="mk-timeslot-select">Timeslot</label>
              <select
                id="mk-timeslot-select"
                class="select select-bordered select-sm w-full"
                bind:value={selectedTimeslot}
                disabled={loading || confirmingAction}
              >
                <option value={null}>Select Timeslot</option>
                {#each timeslots as t (t.id)}
                  <option value={t}>{t.start} - {t.end}</option>
                {/each}
              </select>
            </div>
          </div>

          {#if !selectedTeacher || !selectedTimeslot}
            <div class="border rounded-lg bg-base-200/50 p-4 h-40 flex items-center justify-center">
              <p class="text-xs opacity-50 text-center">Select a teacher and timeslot to continue.</p>
            </div>
          {:else if scheduleLoading}
            <div class="border rounded-lg bg-base-200/50 p-4 h-40 flex items-center justify-center">
              <span class="loading loading-spinner loading-sm"></span>
            </div>
          {:else}
            <div class="bg-base-200 rounded-xl p-4">
              <p class="text-xs font-bold uppercase tracking-widest mb-3">Schedule</p>
              <div class="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p class="text-[10px] opacity-80 uppercase mb-0.5">Teacher</p>
                  <p class="font-bold">{selectedTeacher?.name || '—'}</p>
                </div>
                <div>
                  <p class="text-[10px] opacity-80 uppercase mb-0.5">Room</p>
                  {#if displayRoom}
                    <p class="font-bold">{displayRoom.name}</p>
                  {:else}
                    <select
                      bind:value={selectedRoom}
                      class="select select-bordered select-xs w-full"
                      disabled={loading || scheduleLoading || confirmingAction}
                    >
                      <option value={null}>Select Room</option>
                      <optgroup label="MTM">
                        {#each availableRooms.filter((r) => r.roomType === 'mtm') as r (r.id)}
                          <option value={r}>{r.name}</option>
                        {/each}
                      </optgroup>
                      <optgroup label="GRP">
                        {#each availableRooms.filter((r) => r.roomType === 'grp') as r (r.id)}
                          <option value={r}>{r.name}</option>
                        {/each}
                      </optgroup>
                    </select>
                  {/if}
                </div>
                <div class="col-span-2">
                  <p class="text-[10px] opacity-80 uppercase mb-0.5">Timeslot</p>
                  <p class="font-bold text-sm">
                    {selectedTimeslot ? `${selectedTimeslot.start} – ${selectedTimeslot.end}` : '—'}
                  </p>
                </div>
              </div>
            </div>

            {#if occupiedByOther}
              <div class="alert alert-error alert-soft text-xs py-2">
                <span>
                  ⚠️ <strong>{selectedTeacher?.name}</strong> already has a class at this timeslot that isn't a make-up class.
                  Pick a different teacher or timeslot.
                </span>
              </div>
            {:else if isEditMode}
              <div class="alert alert-info alert-soft text-xs py-2">
                <span>✎ Editing an existing make-up class. Use "Delete Class" below to remove it entirely.</span>
              </div>
            {/if}
          {/if}

          <div class="form-control">
            <label class="label text-xs font-bold" for="makeup-subject">Subject</label>
            <select
              id="makeup-subject"
              bind:value={selectedSubject}
              class="select select-bordered select-sm w-full"
              disabled={loading || !formReady || confirmingAction}
            >
              <option value={null}>Select Subject</option>
              {#each subjects as s (s.id)}
                <option value={s}>{s.name}</option>
              {/each}
            </select>
          </div>

          {#if makeupSchedule}
            <div class="alert alert-soft text-xs py-2">
              <span>✓ Will auto-tag as <strong>{makeupSchedule.name}</strong> custom schedule.</span>
            </div>
          {:else if !loading}
            <div class="alert alert-error alert-soft text-xs py-2">
              <span>
                ⚠️ No <strong>"Make-up Class"</strong> custom schedule found. Please create one in Custom Schedules first.
              </span>
            </div>
          {/if}
        </div>

        <!-- Right Column -->
        <div class="flex flex-col" class:opacity-40={!formReady} class:pointer-events-none={!formReady}>
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
            disabled={!formReady || confirmingAction}
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
                      disabled={confirmingAction || (!isSelected && maxCapacity > 0 && currentCount >= maxCapacity)}
                    />
                    <span class="text-sm {isSelected ? 'font-bold text-primary' : ''}">{s.englishName}</span>
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
      </div>

      <div class="modal-action mt-8 flex items-center justify-between w-full">
        <div class="flex gap-2">
          {#if isEditMode}
            <button
              class="btn btn-error btn-soft btn-sm"
              onclick={requestDelete}
              disabled={loading || confirmingAction}
            >
              Delete Class
            </button>
          {/if}
        </div>
        <div class="flex gap-2">
          <button class="btn btn-ghost btn-soft" onclick={close} disabled={loading || confirmingAction}>Cancel</button>
          <button
            class="btn btn-info btn-soft min-w-[140px]"
            onclick={requestSave}
            disabled={loading || confirmingAction || isOverCapacity || !makeupSchedule || !effectiveRoom || !formReady}
          >
            {isEditMode ? 'Save Changes' : 'Create Make-up Class'}
          </button>
        </div>
      </div>

      <div class="modal-backdrop bg-black/40" role="presentation" onclick={close}></div>
    </div>
  </dialog>

  {#if confirmingAction}
    <dialog class="modal modal-open">
      <div class="modal-box max-w-sm border-2 shadow-2xl {actionType === 'delete' ? 'border-error' : 'border-info'}">
        <div class="flex flex-col items-center text-center gap-2 py-2">
          <p
            class="font-extrabold text-base uppercase tracking-wide {actionType === 'delete'
              ? 'text-error'
              : 'text-info'}"
          >
            {#if actionType === 'delete'}
              Confirm Delete
            {:else if isEditMode}
              Confirm Changes
            {:else}
              Confirm Make-up Class
            {/if}
          </p>
          <p class="text-sm opacity-90 leading-snug">
            {#if actionType === 'delete'}
              Delete this make-up class for <strong>{selectedTeacher.name}</strong>
              at {selectedTimeslot.start} - {selectedTimeslot.end}, affecting {existingSchedules.length} student{existingSchedules.length ===
              1
                ? ''
                : 's'}?
            {:else if isEditMode}
              Save changes to this make-up class for <strong>{selectedTeacher.name}</strong>
              at {selectedTimeslot.start} - {selectedTimeslot.end}?
            {:else}
              Create a make-up class for <strong>{selectedTeacher.name}</strong>
              at {selectedTimeslot.start} - {selectedTimeslot.end} with {selectedStudents.length} student{selectedStudents.length ===
              1
                ? ''
                : 's'}?
            {/if}
          </p>
        </div>
        <div class="modal-action mt-4 justify-center">
          <button class="btn btn-ghost btn-soft" onclick={cancelConfirm} disabled={loading}>Go Back</button>
          <button
            class="btn {actionType === 'delete' ? 'btn-error' : 'btn-info'} min-w-[130px]"
            onclick={confirmAction}
            disabled={loading}
          >
            {#if loading}
              <span class="loading loading-spinner"></span>
            {:else}
              Confirm
            {/if}
          </button>
        </div>
      </div>
      <div class="modal-backdrop bg-black/60" role="presentation" onclick={cancelConfirm}></div>
    </dialog>
  {/if}
{/if}
