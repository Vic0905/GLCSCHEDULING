<script>
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../lib/Pocketbase.svelte'

  let { onrefresh } = $props()

  // ═══════════════════════════════════
  // CONSTANTS
  // ═══════════════════════════════════

  const BREAK_SCHEDULES = ['lunch break', 'break time', 'other task']

  // ═══════════════════════════════════
  // STATE
  // ═══════════════════════════════════

  let show = $state(false)
  let loading = $state(false) // saving
  let scheduleLoading = $state(false) // fetching the teacher+timeslot record
  let yesterdayLoading = $state(false)
  let confirmingSave = $state(false) // true while the "are you sure" step is showing

  // Picker inputs (left column)
  let date = $state(null)
  let teachers = $state([]) // active teachers — used for the Teacher select AND sub candidates
  let timeslots = $state([])
  let selectedTeacher = $state(null)
  let selectedTimeslot = $state(null)

  // Resolved schedule for selectedTeacher + selectedTimeslot + date
  let scheduleRecords = $state([]) // normalized dailySchedule rows (can be >1, e.g. group class)
  let recordIds = $state([])
  let existingSub = $state(null)
  let isBreakSchedule = $state(false)

  // Sub picker (right column)
  let selectedSub = $state(null)
  let busyTeacherIds = $state(new Set())
  let searchQuery = $state('')

  // Read-only context
  let yesterdaySubs = $state([])

  let subClassSchedule = $state(null) // the "Sub Class" customSchedule record

  // ═══════════════════════════════════
  // DERIVED
  // ═══════════════════════════════════

  let displaySubject = $derived(scheduleRecords[0]?.subject || null)
  let displayRoom = $derived(scheduleRecords[0]?.room || null)
  let displayStudents = $derived(scheduleRecords.flatMap((s) => s.students))

  // Exclude the primary teacher and anyone already booked this timeslot
  let availableTeachers = $derived(teachers.filter((t) => t.id !== selectedTeacher?.id && !busyTeacherIds.has(t.id)))
  let unavailableCount = $derived(
    teachers.filter((t) => t.id !== selectedTeacher?.id && busyTeacherIds.has(t.id)).length
  )
  let filteredTeachers = $derived.by(() => {
    const list = availableTeachers.filter((t) => t.name.toLowerCase().includes(searchQuery.toLowerCase().trim()))

    // Pin the currently-assigned sub to the top of the list, so it's easy
    // to find/re-confirm without scrolling.
    if (existingSub) {
      const idx = list.findIndex((t) => t.id === existingSub.id)
      if (idx > 0) {
        const [pinned] = list.splice(idx, 1)
        list.unshift(pinned)
      }
    }

    return list
  })

  // Whether the current selection differs from what's actually saved —
  // used to disable the Save button when there's nothing to save.
  let hasChange = $derived((selectedSub?.id || null) !== (existingSub?.id || null))

  // ═══════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════

  function offsetDate(dateStr, days) {
    const d = new Date(dateStr)
    d.setDate(d.getDate() + days)
    return d.toISOString().split('T')[0]
  }

  function normalizeSchedules(rawSchedules) {
    return rawSchedules.map((s) => ({
      id: s.id,
      room: s.expand?.room || null,
      roomName: s.expand?.room?.name || null,
      students: s.expand?.student ? [{ id: s.expand.student.id, name: s.expand.student.englishName }] : [],
      subject: s.expand?.subject,
      sub: s.expand?.sub || null,
      customSchedule: s.expand?.customSchedule || [],
    }))
  }

  // ═══════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════

  async function loadCustomSchedule() {
    try {
      const customSchedules = await pb.collection('customSchedule').getFullList({ sort: 'name' })
      subClassSchedule = customSchedules.find((cs) => cs.name.toLowerCase().trim() === 'sub class') || null
    } catch {
      toast.error('Failed to load custom schedule config')
    }
  }

  // Fetch the selected teacher's schedule record(s) for the selected
  // date + timeslot (there can be more than one row, e.g. group classes).
  async function loadScheduleForSelection() {
    scheduleLoading = true
    confirmingSave = false
    selectedSub = null
    try {
      const records = await pb.collection('dailySchedule').getFullList({
        filter: `date >= "${date} 00:00:00" && date <= "${date} 23:59:59" && teacher = "${selectedTeacher.id}" && timeslot = "${selectedTimeslot.id}"`,
        expand: 'student,subject,room,customSchedule,sub',
      })

      scheduleRecords = normalizeSchedules(records)
      recordIds = scheduleRecords.map((r) => r.id)
      existingSub = scheduleRecords[0]?.sub || null
      selectedSub = existingSub
      isBreakSchedule = scheduleRecords.some((r) =>
        (r.customSchedule || []).some((cs) => BREAK_SCHEDULES.includes(cs.name?.toLowerCase().trim()))
      )

      await Promise.all([loadBusyTeachers(), loadYesterdayContext()])
    } catch {
      toast.error('Failed to load schedule for this teacher/timeslot')
    } finally {
      scheduleLoading = false
    }
  }

  // Fetch everyone already teaching (as teacher or sub) at this exact
  // date + timeslot, so they can't be double-booked as a substitute.
  async function loadBusyTeachers() {
    busyTeacherIds = new Set()
    if (!selectedTimeslot?.id || !date) return

    try {
      const records = await pb.collection('dailySchedule').getFullList({
        filter: `date >= "${date} 00:00:00" && date <= "${date} 23:59:59" && timeslot = "${selectedTimeslot.id}"`,
        fields: 'id,teacher,sub',
      })

      const busy = new Set()
      for (const r of records) {
        if (recordIds.includes(r.id)) continue // skip the record(s) currently being edited
        if (r.teacher) busy.add(r.teacher)
        if (r.sub) busy.add(r.sub)
      }
      busyTeacherIds = busy
    } catch {
      toast.error('Failed to check teacher availability')
    }
  }

  // Read-only lookup: which substitute(s), if any, covered these same
  // students' timeslot the day before — quick "was there a sub yesterday"
  // check with no other detail.
  async function loadYesterdayContext() {
    yesterdaySubs = []
    if (!selectedTimeslot?.id || !date || !displayStudents.length) return

    yesterdayLoading = true
    try {
      const yesterday = offsetDate(date, -1)
      const studentIds = displayStudents.map((s) => s.id).filter(Boolean)
      if (!studentIds.length) return
      const studentFilter = studentIds.map((id) => `student = "${id}"`).join(' || ')

      const records = await pb.collection('dailySchedule').getFullList({
        filter: `date >= "${yesterday} 00:00:00" && date <= "${yesterday} 23:59:59" && timeslot = "${selectedTimeslot.id}" && (${studentFilter})`,
        expand: 'sub',
      })

      yesterdaySubs = [...new Set(records.map((r) => r.expand?.sub?.name).filter(Boolean))]
    } catch {
      toast.error("Failed to load yesterday's class info")
    } finally {
      yesterdayLoading = false
    }
  }

  // ═══════════════════════════════════
  // REACTIVITY — refetch the schedule whenever teacher/timeslot changes
  // ═══════════════════════════════════

  $effect(() => {
    if (show && selectedTeacher && selectedTimeslot) {
      loadScheduleForSelection()
    } else {
      scheduleRecords = []
      recordIds = []
      existingSub = null
      selectedSub = null
      isBreakSchedule = false
      busyTeacherIds = new Set()
      yesterdaySubs = []
      confirmingSave = false
    }
  })

  // ═══════════════════════════════════
  // MODAL LIFECYCLE
  // ═══════════════════════════════════

  // data: { date, teachers, timeslots } — teacher/timeslot are picked
  // inside the modal, nothing is pre-filled from a grid cell anymore.
  export async function open(data) {
    show = true
    loading = false
    confirmingSave = false
    date = data.date
    teachers = (data.teachers || []).filter((t) => t.status !== 'disabled')
    timeslots = data.timeslots || []
    selectedTeacher = null
    selectedTimeslot = null
    searchQuery = ''

    if (!subClassSchedule) await loadCustomSchedule()
  }

  function close() {
    show = false
    loading = false
    scheduleLoading = false
    confirmingSave = false
    date = null
    teachers = []
    timeslots = []
    selectedTeacher = null
    selectedTimeslot = null
    scheduleRecords = []
    recordIds = []
    existingSub = null
    selectedSub = null
    isBreakSchedule = false
    busyTeacherIds = new Set()
    yesterdaySubs = []
    searchQuery = ''
  }

  // ═══════════════════════════════════
  // SAVE (two-step: request → confirm)
  // ═══════════════════════════════════

  // Triggered by the "Save Sub" button — shows the confirmation banner
  // instead of saving immediately.
  function requestSave() {
    if (!recordIds.length) return toast.error('No schedule found for this teacher at this timeslot')
    if (selectedSub && isBreakSchedule) return toast.error('Cannot assign a sub to a break/lunch schedule')
    confirmingSave = true
  }

  // Triggered by the dedicated "Remove Sub" quick-action button — clears
  // the selection and jumps straight to the confirmation step, without
  // requiring the user to pick "No substitute" in the list first.
  function quickRemove() {
    if (!recordIds.length) return toast.error('No schedule found for this teacher at this timeslot')
    selectedSub = null
    confirmingSave = true
  }

  function cancelConfirm() {
    confirmingSave = false
  }

  // Triggered by the "Confirm" button in the confirmation banner.
  async function confirmSave() {
    const success = await save()
    confirmingSave = false
    if (success) {
      resetPickers()
    }
  }

  // Clears teacher/timeslot (and search) so the modal is ready for a brand
  // new sub assignment. The $effect below handles clearing everything else
  // (scheduleRecords, selectedSub, busyTeacherIds, etc) once selectedTeacher
  // / selectedTimeslot go null.
  function resetPickers() {
    selectedTimeslot = null
    searchQuery = ''
  }

  async function save() {
    if (!recordIds.length) {
      toast.error('No schedule found for this teacher at this timeslot')
      return false
    }
    if (selectedSub && isBreakSchedule) {
      toast.error('Cannot assign a sub to a break/lunch schedule')
      return false
    }

    loading = true
    try {
      // Get the current customSchedule arrays fresh, so we don't clobber
      // tags that were set outside this modal's knowledge.
      const freshRecords = await pb.collection('dailySchedule').getFullList({
        filter: recordIds.map((id) => `id = "${id}"`).join(' || '),
        fields: 'id,customSchedule',
      })
      const currentMap = new Map(freshRecords.map((r) => [r.id, r.customSchedule || []]))

      const batch = pb.createBatch()

      for (const id of recordIds) {
        const current = currentMap.get(id) || []
        let updatedCustomSchedule

        if (selectedSub && subClassSchedule) {
          updatedCustomSchedule = current.includes(subClassSchedule.id) ? current : [...current, subClassSchedule.id]
        } else {
          updatedCustomSchedule = current.filter((csId) => csId !== subClassSchedule?.id)
        }

        batch.collection('dailySchedule').update(id, {
          sub: selectedSub ? selectedSub.id : null,
          customSchedule: updatedCustomSchedule,
        })
      }

      await batch.send()

      const logAction =
        existingSub && !selectedSub
          ? 'sub_remove'
          : existingSub && selectedSub
            ? 'sub_edit'
            : selectedSub
              ? 'sub'
              : null

      if (logAction) {
        try {
          await pb.collection('activityLog').create({
            action: logAction,
            performedBy: pb.authStore.record?.id,
            details: {
              date,
              timeslot: selectedTimeslot ? `${selectedTimeslot.start} - ${selectedTimeslot.end}` : null,
              roomName: displayRoom?.name,
              teacherName: selectedTeacher?.name,
              subName: selectedSub?.name || null,
            },
          })
        } catch (logErr) {
          console.error('Activity log failed:', logErr)
        }
      }

      toast.success(selectedSub ? `Sub assigned: ${selectedSub.name}` : 'Sub teacher removed')
      onrefresh?.() // refresh the underlying grid in the background
      return true
    } catch (e) {
      toast.error(e.message || 'Failed to save')
      return false
    } finally {
      loading = false
    }
  }
</script>

{#if show}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-3xl border border-base-300 shadow-2xl">
      <!-- Header -->
      <header class="mb-6 text-center">
        <h3 class="text-xl font-bold">Sub Class Assignment</h3>
        <p class="text-xs uppercase tracking-widest">{date}</p>
      </header>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <!-- Left Column: Teacher / Timeslot / Schedule Record -->
        <div class="flex flex-col">
          <div class="form-control mb-3">
            <label class="label text-xs font-bold uppercase" for="teacher-select">Teacher</label>
            <select
              id="teacher-select"
              class="select select-bordered select-sm w-full"
              bind:value={selectedTeacher}
              disabled={loading || confirmingSave}
            >
              <option value={null}>— Select Teacher —</option>
              {#each teachers as t (t.id)}
                <option value={t}>{t.name}</option>
              {/each}
            </select>
          </div>

          <div class="form-control mb-4">
            <label class="label text-xs font-bold uppercase" for="timeslot-select">Timeslot</label>
            <select
              id="timeslot-select"
              class="select select-bordered select-sm w-full"
              bind:value={selectedTimeslot}
              disabled={loading || confirmingSave}
            >
              <option value={null}>— Select Timeslot —</option>
              {#each timeslots as t (t.id)}
                <option value={t}>{t.start} - {t.end}</option>
              {/each}
            </select>
          </div>

          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="text-xs font-bold uppercase mb-2 block">Schedule Record</label>

          {#if !selectedTeacher || !selectedTimeslot}
            <div class="border rounded-lg bg-base-200/50 p-4 h-72 flex items-center justify-center">
              <p class="text-xs opacity-50 text-center">Select a teacher and timeslot to view the schedule.</p>
            </div>
          {:else if scheduleLoading}
            <div class="border rounded-lg bg-base-200/50 p-4 h-72 flex items-center justify-center">
              <span class="loading loading-spinner loading-sm"></span>
            </div>
          {:else if !recordIds.length}
            <div class="border rounded-lg bg-base-200/50 p-4 h-72 flex items-center justify-center">
              <p class="text-xs opacity-50 text-center">
                No schedule found for <strong>{selectedTeacher.name}</strong> at this timeslot on {date}.
              </p>
            </div>
          {:else}
            <div class="bg-base-200 rounded-xl p-4">
              <div class="grid grid-cols-2 gap-3 text-sm mb-3">
                <div>
                  <p class="text-[10px] opacity-80 uppercase mb-0.5">Subject</p>
                  <p class="font-bold">{displaySubject?.name || '—'}</p>
                </div>
                <div>
                  <p class="text-[10px] opacity-80 uppercase mb-0.5">Room</p>
                  <p class="font-bold">{displayRoom?.name || '—'}</p>
                </div>
              </div>
              <div>
                <p class="text-[10px] opacity-80 uppercase mb-1">Students ({displayStudents.length})</p>
                <div class="flex flex-wrap gap-1">
                  {#each displayStudents as s}
                    <span class="font-bold text-sm">{s.name}</span>
                  {:else}
                    <span class="text-xs opacity-40">No students</span>
                  {/each}
                </div>
              </div>

              {#if isBreakSchedule}
                <div class="alert alert-error alert-soft text-xs py-2 mt-3">
                  <span>⚠️ This is a break/lunch/other slot and can't have a sub assigned.</span>
                </div>
              {/if}
            </div>

            {#if yesterdayLoading}
              <div class="flex items-center gap-2 text-xs opacity-50 mt-3">
                <span class="loading loading-spinner loading-xs"></span>
                Checking yesterday's sub…
              </div>
            {:else if yesterdaySubs.length > 0}
              <div class="bg-base-200 rounded-xl p-4 mt-3">
                <p class="text-[10px] font-bold uppercase opacity-40 tracking-widest mb-2">Yesterday's Sub</p>
                <div class="flex flex-wrap gap-1">
                  {#each yesterdaySubs as name}
                    <span class="text text-sm font-bold">{name}</span>
                  {/each}
                </div>
              </div>
            {/if}

            {#if existingSub}
              <div class="alert alert-info alert-soft text-xs py-2 mt-3">
                <span>Currently subbed by <strong>{existingSub.name}</strong>.</span>
              </div>
            {/if}
          {/if}
        </div>
        <!-- END Left Column -->

        <!-- Right Column: Sub Teacher Selection -->
        <div class="flex flex-col" class:opacity-40={isBreakSchedule} class:pointer-events-none={isBreakSchedule}>
          <div class="flex justify-between items-center mb-2">
            <!-- svelte-ignore a11y_label_has_associated_control -->
            <label class="text-xs font-bold uppercase">Substitute Teacher</label>
            <span class="badge badge-ghost badge-sm">
              {selectedTeacher && selectedTimeslot && recordIds.length ? `${availableTeachers.length} available` : '—'}
            </span>
          </div>

          <input
            type="text"
            placeholder="Search teachers..."
            bind:value={searchQuery}
            class="input input-bordered input-sm w-full mb-3"
            disabled={!selectedTeacher || !selectedTimeslot || !recordIds.length || confirmingSave}
          />

          <div class="border rounded-lg overflow-y-auto bg-base-200/50 p-2 h-72">
            {#if !selectedTeacher || !selectedTimeslot}
              <p class="text-xs opacity-50 p-4 text-center">Select a teacher and timeslot first.</p>
            {:else if scheduleLoading}
              <p class="text-xs opacity-50 p-4 text-center">Loading...</p>
            {:else if !recordIds.length}
              <p class="text-xs opacity-50 p-4 text-center">No schedule to assign a sub to.</p>
            {:else}
              <!-- "No substitute" clears the sub (equivalent to the old toggle-off) -->
              <div class="mb-1 rounded-md {!selectedSub ? 'bg-base-300/60' : ''}">
                <label class="flex items-center gap-3 p-2 hover:bg-base-300 rounded-md cursor-pointer">
                  <input
                    type="radio"
                    name="sub-teacher"
                    class="radio radio-primary radio-sm"
                    checked={!selectedSub}
                    onchange={() => (selectedSub = null)}
                    disabled={confirmingSave}
                  />
                  <span class="text-sm {!selectedSub ? 'font-bold text-primary' : 'opacity-60'}">No substitute</span>
                </label>
              </div>

              {#each filteredTeachers as t (t.id)}
                {@const isSelected = selectedSub?.id === t.id}
                <div class="mb-1 rounded-md {isSelected ? 'bg-base-300/60' : ''}">
                  <label class="flex items-center gap-3 p-2 hover:bg-base-300 rounded-md cursor-pointer">
                    <input
                      type="radio"
                      name="sub-teacher"
                      class="radio radio-primary radio-sm"
                      checked={isSelected}
                      onchange={() => (selectedSub = t)}
                      disabled={confirmingSave}
                    />
                    <span class="text-sm {isSelected ? 'font-bold text-primary' : ''}">
                      {t.name}
                    </span>
                  </label>
                </div>
              {:else}
                <p class="text-xs opacity-50 p-4 text-center">No teachers match your search.</p>
              {/each}
            {/if}
          </div>

          {#if selectedTeacher && selectedTimeslot && recordIds.length && unavailableCount > 0}
            <p class="text-xs opacity-60 mt-1">
              {unavailableCount} teacher{unavailableCount === 1 ? '' : 's'} already booked this timeslot, hidden.
            </p>
          {/if}

          {#if recordIds.length && !subClassSchedule}
            <div class="alert alert-error alert-soft text-xs py-2 mt-2">
              <span>
                ⚠️ No <strong>"Sub Class"</strong> custom schedule found. Please create one in Custom Schedules first.
              </span>
            </div>
          {/if}
        </div>
        <!-- END Right Column -->
      </div>

      <!-- Actions -->
      <div class="modal-action mt-4">
        <button class="btn btn-ghost btn-soft" onclick={close} disabled={loading || confirmingSave}>Cancel</button>

        {#if existingSub}
          <!-- Quick-action: remove the current sub in one click, no need
               to select "No substitute" in the list first. -->
          <button
            class="btn btn-error btn-soft"
            onclick={quickRemove}
            disabled={loading || scheduleLoading || confirmingSave || !recordIds.length}
          >
            Remove Sub
          </button>
        {/if}

        <button
          class="btn btn-info btn-soft min-w-[130px]"
          onclick={requestSave}
          disabled={loading ||
            scheduleLoading ||
            confirmingSave ||
            !selectedTeacher ||
            !selectedTimeslot ||
            !recordIds.length ||
            !hasChange ||
            (selectedSub && isBreakSchedule) ||
            (selectedSub && !subClassSchedule)}
        >
          Save Sub
        </button>
      </div>
    </div>

    <div class="modal-backdrop bg-black/40" role="presentation" onclick={close}></div>
  </dialog>

  {#if confirmingSave}
    <!-- Confirmation POPUP — a separate dialog stacked on top of the main
         modal, with its own darker backdrop, so it reads as a distinct
         "are you sure?" prompt rather than an inline banner. -->
    <dialog class="modal modal-open">
      <div class="modal-box max-w-sm border-2 shadow-2xl {selectedSub ? 'border-info' : 'border-error'}">
        <div class="flex flex-col items-center text-center gap-2 py-2">
          <span class="text-5xl leading-none">{selectedSub ? '' : ''}</span>
          <p class="font-extrabold text-base uppercase tracking-wide {selectedSub ? 'text-info' : 'text-error'}">
            {selectedSub ? 'Confirm Sub Assignment' : 'Confirm Sub Removal'}
          </p>
          <p class="text-sm opacity-90 leading-snug">
            {#if selectedSub}
              Assign <strong>{selectedSub.name}</strong> as substitute for
              <strong>{selectedTeacher.name}</strong>
              at {selectedTimeslot.start} - {selectedTimeslot.end}?
            {:else}
              Remove <strong>{existingSub?.name}</strong> as substitute for
              <strong>{selectedTeacher.name}</strong>
              at {selectedTimeslot.start} - {selectedTimeslot.end}?
            {/if}
          </p>
        </div>
        <div class="modal-action mt-4 justify-center">
          <button class="btn btn-ghost btn-soft" onclick={cancelConfirm} disabled={loading}>Go Back</button>
          <button
            class="btn {selectedSub ? 'btn-info' : 'btn-error'} min-w-[130px]"
            onclick={confirmSave}
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
