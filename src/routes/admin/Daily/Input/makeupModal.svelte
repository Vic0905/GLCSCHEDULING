<script>
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../lib/Pocketbase.svelte'

  let { onrefresh } = $props()

  // ═══════════════════════════════════
  // STATE
  // ═══════════════════════════════════

  let show = $state(false)
  let loading = $state(false)

  // Pre-filled, read-only (comes from the clicked empty cell)
  let displayTeacher = $state(null)
  let displayRoom = $state(null)
  let displayTimeslot = $state(null)
  let displayDate = $state(null)

  // Dropdown data
  let availableRooms = $state([])
  let selectedRoom = $state(null)
  let effectiveRoom = $derived(displayRoom || selectedRoom)
  let subjects = $state([])
  let students = $state([])
  let customSchedules = $state([])
  let makeupSchedule = $state(null) // the "Make-up Class" customSchedule record

  // Form
  let selectedSubject = $state(null)
  let selectedStudents = $state([]) // array of student ids

  // Edit Mode
  let existingSchedules = $state([]) // [{id, studentId}] — populated when editing an existing make-up class
  let isEditMode = $state(false)
  let rawSchedules = $state([])

  // Student search
  let searchQuery = $state('')

  // ═══════════════════════════════════
  // DERIVED
  // ═══════════════════════════════════

  let maxCapacity = $derived(effectiveRoom?.maxStudents || 0)
  let currentCount = $derived(selectedStudents.length)
  let isOverCapacity = $derived(maxCapacity > 0 && currentCount > maxCapacity)

  let filteredStudents = $derived.by(() => {
    const query = searchQuery.toLowerCase()

    // Same "latest record per student" dedup as the class modal
    const latest = new Map()
    for (const s of students) {
      const existing = latest.get(s.englishName)
      if (!existing || s.start > existing.start) {
        latest.set(s.englishName, s)
      }
    }

    return [...latest.values()]
      .filter((s) => s.englishName?.toLowerCase().includes(query))
      .sort((a, b) => {
        const aSelected = selectedStudents.includes(a.id)
        const bSelected = selectedStudents.includes(b.id)
        return bSelected - aSelected
      })
  })

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
        displayRoom ? Promise.resolve([]) : pb.collection('roomType').getFullList({ sort: 'roomType,name' }),
      ])
      subjects = subj
      students = stu
      customSchedules = cs
      makeupSchedule = cs.find((c) => c.name.toLowerCase().trim() === 'make-up class') || null
      if (!displayRoom) availableRooms = rooms
    } catch {
      toast.error('Failed to load dropdown data')
    }
  }

  // ═══════════════════════════════════
  // MODAL LIFECYCLE
  // ═══════════════════════════════════

  export async function open(data) {
    show = true
    loading = true

    displayTeacher = data.teacher || null
    displayRoom = data.room || null
    displayTimeslot = data.timeslot || null
    displayDate = data.date || null

    rawSchedules = data.schedules || []
    existingSchedules = rawSchedules
      .map((s) => ({ id: s.id, studentId: s.students?.[0]?.id }))
      .filter((s) => s.studentId)
    isEditMode = existingSchedules.length > 0

    const initialSubjectId = isEditMode ? rawSchedules[0]?.subject?.id : null

    selectedSubject = null
    selectedStudents = existingSchedules.map((s) => s.studentId)
    selectedRoom = null
    searchQuery = ''

    await loadData()

    if (initialSubjectId) {
      selectedSubject = subjects.find((s) => s.id === initialSubjectId) || null
    }

    loading = false
  }

  function close() {
    show = false
    loading = false
    selectedSubject = null
    selectedStudents = []
    searchQuery = ''
    existingSchedules = []
    isEditMode = false
    rawSchedules = []
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
      filter: `timeslot = "${displayTimeslot.id}" && date >= "${displayDate} 00:00:00" && date <= "${displayDate} 23:59:59"`,
      expand: 'room,teacher,student,sub',
    })

    const relevant = records.filter((r) => !excludeIds.includes(r.id))

    const teacherBusy = relevant.find((s) => s.teacher === displayTeacher.id || s.sub === displayTeacher.id)
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
  // SAVE
  // ═══════════════════════════════════

  async function save() {
    const error = validateForm()
    if (error) return toast.error(error)

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
          teacher: displayTeacher.id,
          room: effectiveRoom.id,
          timeslot: displayTimeslot.id,
          subject: selectedSubject.id,
          student: studentId,
          date: `${displayDate} 00:00:00.000Z`,
          status: 'draft',
          customSchedule: [makeupSchedule.id],
        })
      })

      toDelete.forEach((s) => batch.collection('dailySchedule').delete(s.id))

      toKeep.forEach((s) => {
        batch.collection('dailySchedule').update(s.id, { subject: selectedSubject.id })
      })

      await batch.send()

      // ─── ACTIVITY LOG ───
      // 'makeup' for new classes, 'makeup_edit' for changes to an existing one.
      try {
        await pb.collection('activityLog').create({
          action: isEditMode ? 'makeup_edit' : 'makeup',
          performedBy: pb.authStore.record?.id,
          details: {
            date: displayDate,
            timeslot: displayTimeslot ? `${displayTimeslot.start} - ${displayTimeslot.end}` : null,
            roomName: effectiveRoom?.name,
            teacherName: displayTeacher?.name,
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
      // ─── END ACTIVITY LOG ───

      toast.success(
        isEditMode
          ? 'Make-up class updated'
          : `Make-up class created for ${selectedStudents.length} student${selectedStudents.length === 1 ? '' : 's'}`
      )
      onrefresh?.()
      close()
    } catch (e) {
      toast.error(e.message || 'Failed to save')
    } finally {
      loading = false
    }
  }

  async function deleteAll() {
    if (!existingSchedules.length) return
    if (!confirm('Delete this entire make-up class?')) return

    loading = true
    try {
      const batch = pb.createBatch()
      existingSchedules.forEach((s) => batch.collection('dailySchedule').delete(s.id))
      await batch.send()

      // ─── ACTIVITY LOG ───
      try {
        await pb.collection('activityLog').create({
          action: 'makeup_delete',
          performedBy: pb.authStore.record?.id,
          details: {
            date: displayDate,
            timeslot: displayTimeslot ? `${displayTimeslot.start} - ${displayTimeslot.end}` : null,
            roomName: effectiveRoom?.name,
            teacherName: displayTeacher?.name,
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
      // ─── END ACTIVITY LOG ───

      toast.success('Make-up class deleted')
      onrefresh?.()
      close()
    } catch (e) {
      toast.error(e.message || 'Failed to delete')
    } finally {
      loading = false
    }
  }
</script>

{#if show}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-2xl border border-base-300 shadow-2xl">
      <header class="mb-6 text-center">
        <h3 class="text-xl font-bold">{isEditMode ? 'Edit Make-up Class' : 'Make-up Class'}</h3>
        <p class="text-xs uppercase tracking-widest">{displayDate}</p>
      </header>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
        <!-- Left Column: Schedule Info + Subject -->
        <div class="space-y-4">
          <div class="bg-base-200 rounded-xl p-4">
            <p class="text-xs font-bold uppercase tracking-widest mb-3">Schedule</p>
            <div class="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p class="text-[10px] opacity-80 uppercase mb-0.5">Teacher</p>
                <p class="font-bold">{displayTeacher?.name || '—'}</p>
              </div>
              <div>
                <p class="text-[10px] opacity-80 uppercase mb-0.5">Room</p>
                {#if displayRoom}
                  <p class="font-bold">{displayRoom.name}</p>
                {:else}
                  <select bind:value={selectedRoom} class="select select-bordered select-xs w-full" disabled={loading}>
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
                  {displayTimeslot ? `${displayTimeslot.start} – ${displayTimeslot.end}` : '—'}
                </p>
              </div>
            </div>
          </div>

          <div class="form-control">
            <label class="label text-xs font-bold" for="makeup-subject">Subject</label>
            <select
              id="makeup-subject"
              bind:value={selectedSubject}
              class="select select-bordered select-sm w-full"
              disabled={loading}
            >
              <option value={null}>— Select Subject —</option>
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
        <!-- END Left Column -->

        <!-- Right Column: Student Selection -->
        <div class="flex flex-col">
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

      <div class="modal-action mt-8 flex items-center justify-between w-full">
        <div class="flex gap-2">
          {#if isEditMode}
            <button class="btn btn-error btn-soft btn-sm" onclick={deleteAll} disabled={loading}> Delete Class </button>
          {/if}
        </div>
        <div class="flex gap-2">
          <button class="btn btn-ghost btn-soft" onclick={close} disabled={loading}>Cancel</button>
          <button
            class="btn btn-info btn-soft min-w-[140px]"
            onclick={save}
            disabled={loading || isOverCapacity || !makeupSchedule || !effectiveRoom}
          >
            {#if loading}
              <span class="loading loading-spinner"></span>
            {:else if isEditMode}
              Save Changes
            {:else}
              Create Make-up Class
            {/if}
          </button>
        </div>
      </div>

      <div class="modal-backdrop bg-black/40" role="presentation" onclick={close}></div>
    </div>
  </dialog>
{/if}
