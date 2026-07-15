<script>
  import { toast } from 'svelte-sonner'
  import { onMount } from 'svelte'
  import { pb } from '../../../../../lib/Pocketbase.svelte'

  // --- Config ---
  // Adjust these if your teachers collection/field names differ.
  const TEACHERS_COLLECTION = 'teacher'
  const TEACHER_NAME_FIELD = 'name'

  const REASON_OPTIONS = ['Sick', 'Vacation', 'Emergency', 'Other']

  // --- State ---
  let absences = $state([])
  let teachers = $state([])
  let isLoading = $state(false)
  let showModal = $state(false)
  let showDayModal = $state(false)
  let dayModalDate = $state(null)
  let currentMonth = $state(new Date(new Date().getFullYear(), new Date().getMonth(), 1))

  let formData = $state({
    id: null,
    teacher: '', // single teacher id — used when editing an existing record
    reason: 'Sick', // used when editing an existing record
    selections: {}, // create mode: { [teacherId]: reason } — each teacher gets their own reason
    date: '',
  })

  const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  function formatDateKey(date) {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  const todayKey = formatDateKey(new Date())

  function formatDateLong(date) {
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  }

  // Softer, more legible palette per reason (bg tint / text / dot accent)
  function reasonStyle(reason) {
    if (reason === 'Sick') {
      return { bg: 'bg-[#FDECEA]', text: 'text-[#C0392B]', dot: 'bg-[#E4574B]' }
    }
    if (reason === 'Vacation') {
      return { bg: 'bg-[#FFF5DE]', text: 'text-[#8A5A00]', dot: 'bg-[#E9B949]' }
    }
    if (reason === 'Emergency') {
      return { bg: 'bg-[#FCE4E4]', text: 'text-[#9B2226]', dot: 'bg-[#D62839]' }
    }
    return { bg: 'bg-[#F1F0EE]', text: 'text-[#5B5750]', dot: 'bg-[#A8A29E]' } // Other / fallback
  }

  function teacherName(item) {
    return item.expand?.teacher?.[TEACHER_NAME_FIELD] || 'Unknown Teacher'
  }

  function toggleTeacher(id) {
    if (formData.selections[id] !== undefined) {
      const { [id]: _removed, ...rest } = formData.selections
      formData.selections = rest
    } else {
      formData.selections = { ...formData.selections, [id]: 'Sick' }
    }
  }

  function setSelectionReason(id, reason) {
    formData.selections = { ...formData.selections, [id]: reason }
  }

  // --- Calendar grid derivation ---
  let calendarDays = $derived.by(() => {
    const year = currentMonth.getFullYear()
    const month = currentMonth.getMonth()
    const firstDay = new Date(year, month, 1)
    const startOffset = firstDay.getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const daysInPrevMonth = new Date(year, month, 0).getDate()

    const days = []

    for (let i = startOffset - 1; i >= 0; i--) {
      days.push({ date: new Date(year, month - 1, daysInPrevMonth - i), inMonth: false })
    }
    for (let d = 1; d <= daysInMonth; d++) {
      days.push({ date: new Date(year, month, d), inMonth: true })
    }
    while (days.length % 7 !== 0) {
      const next = new Date(days[days.length - 1].date)
      next.setDate(next.getDate() + 1)
      days.push({ date: next, inMonth: false })
    }

    return days
  })

  let absencesMap = $derived.by(() => {
    const map = new Map()
    for (const item of absences) {
      const key = formatDateKey(new Date(item.date))
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(item)
    }
    return map
  })

  let monthLabel = $derived(currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))

  let dayModalItems = $derived.by(() => {
    if (!dayModalDate) return []
    return absencesMap.get(formatDateKey(dayModalDate)) || []
  })

  function prevMonth() {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1)
  }
  function nextMonth() {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1)
  }
  function goToday() {
    const t = new Date()
    currentMonth = new Date(t.getFullYear(), t.getMonth(), 1)
  }

  // --- Data Loading ---
  async function loadAbsences() {
    if (isLoading) return

    isLoading = true
    try {
      const records = await pb.collection('teacherAbsences').getFullList({
        sort: '-created',
        expand: 'teacher',
      })
      absences = records.sort((a, b) => new Date(a.date) - new Date(b.date))
    } catch (err) {
      console.error('Load failed:', err)
      toast.error('Failed to load teacher absences')
    } finally {
      isLoading = false
    }
  }

  async function loadTeachers() {
    try {
      const records = await pb.collection(TEACHERS_COLLECTION).getFullList({
        sort: TEACHER_NAME_FIELD,
        fields: `id,${TEACHER_NAME_FIELD},status`,
      })
      teachers = records.filter((t) => t.status !== 'disabled')
    } catch (err) {
      console.error('Load teachers failed:', err)
      toast.error('Failed to load teachers list')
    }
  }

  // --- Save (Create/Update) ---
  function resetForm() {
    showModal = false
    formData = {
      id: null,
      teacher: '',
      reason: 'Sick',
      selections: {},
      date: '',
    }
  }

  function isDuplicate(teacherId, date, excludeId = null) {
    return absences.some(
      (a) => a.teacher === teacherId && formatDateKey(new Date(a.date)) === date && a.id !== excludeId
    )
  }

  // Pulls the actual field-level message out of a PocketBase ClientResponseError
  // (e.g. "reason: Must be one of the allowed values") instead of a generic 400.
  function describeError(err) {
    const fieldErrors = err?.response?.data || err?.data
    if (fieldErrors && typeof fieldErrors === 'object') {
      const [field, detail] = Object.entries(fieldErrors)[0] || []
      if (field && detail?.message) return `${field}: ${detail.message}`
    }
    return err?.message || 'Save failed'
  }

  async function saveAbsence() {
    const date = formData.date
    if (!date) {
      toast.error('Please pick a date')
      return
    }

    // --- Editing an existing single record ---
    if (formData.id) {
      const teacher = formData.teacher
      const reason = formData.reason

      if (!teacher || !reason) {
        toast.error('Please fill in all fields')
        return
      }
      if (isDuplicate(teacher, date, formData.id)) {
        toast.error('This teacher is already marked absent on this date')
        return
      }
      try {
        await pb.collection('teacherAbsences').update(formData.id, { teacher, date, reason })
        toast.success('Updated')
        resetForm()
        await loadAbsences()
      } catch (err) {
        console.error('Save failed:', err)
        toast.error(describeError(err))
      }
      return
    }

    // --- Creating new records, one per selected teacher, each with its own reason ---
    const selectedIds = Object.keys(formData.selections)
    if (!selectedIds.length) {
      toast.error('Please select at least one teacher')
      return
    }

    const entries = selectedIds.map((teacherId) => ({ teacherId, reason: formData.selections[teacherId] }))

    const skipped = []
    const toCreate = entries.filter((e) => {
      if (isDuplicate(e.teacherId, date)) {
        skipped.push(teachers.find((t) => t.id === e.teacherId)?.[TEACHER_NAME_FIELD] || 'Unknown')
        return false
      }
      return true
    })

    if (!toCreate.length) {
      toast.error('Selected teacher(s) already marked absent on this date')
      return
    }

    const results = await Promise.allSettled(
      toCreate.map((e) =>
        pb
          .collection('teacherAbsences')
          .create({ teacher: e.teacherId, date, reason: e.reason })
          .then(() => ({ ok: true, e }))
          .catch((err) => {
            console.error('Save failed for', e, err)
            return { ok: false, e, err }
          })
      )
    )

    const succeeded = results.filter((r) => r.value?.ok).length
    const failed = results.filter((r) => r.value && !r.value.ok).map((r) => r.value)

    if (succeeded) {
      const parts = [`Created ${succeeded}`]
      if (skipped.length) parts.push(`skipped ${skipped.length} already marked absent`)
      if (failed.length) parts.push(`${failed.length} failed`)
      toast.success(parts.join(', '))
    }

    if (failed.length) {
      const name = teachers.find((t) => t.id === failed[0].e.teacherId)?.[TEACHER_NAME_FIELD] || 'a teacher'
      toast.error(`${name}: ${describeError(failed[0].err)}`)
    }

    if (succeeded) {
      resetForm()
      await loadAbsences()
    }
  }

  // --- Delete ---
  async function deleteAbsence(item) {
    if (!confirm(`Remove absence for "${teacherName(item)}"?`)) return

    try {
      await pb.collection('teacherAbsences').delete(item.id)
      toast.success('Deleted')
      await loadAbsences()
    } catch (err) {
      console.error('Delete failed:', err)
      toast.error('Delete failed')
    }
  }

  // --- UI Helpers ---
  function openEdit(item) {
    formData = {
      id: item.id,
      teacher: item.teacher,
      reason: item.reason,
      selections: {},
      date: formatDateKey(new Date(item.date)),
    }
    showModal = true
  }

  function openCreate(dateObj) {
    formData = {
      id: null,
      teacher: '',
      reason: 'Sick',
      selections: {},
      date: dateObj ? formatDateKey(dateObj) : '',
    }
    showModal = true
  }

  function openDayList(dateObj) {
    dayModalDate = dateObj
    showDayModal = true
  }

  onMount(() => {
    loadAbsences()
    loadTeachers()
  })
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link
    href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Inter:wght@400;500;600&display=swap"
    rel="stylesheet"
  />
</svelte:head>

<main class="calendar-shell p-8 max-w-[90rem] mx-auto space-y-6">
  <header class="flex justify-between items-center border-b border-base-200 pb-6">
    <div>
      <h1 class="text-3xl font-extrabold tracking-tight text-base-content">Teacher Absences</h1>
      <p class="text-sm text-base-content/50 mt-1">Track sick days, leave, and other teacher absences</p>
      <p class="text-sm text-base-content/40 mt-1 h-5 transition-opacity {isLoading ? 'opacity-100' : 'opacity-0'}">
        Loading…
      </p>
    </div>
    <button class="btn btn-info opacity-80 rounded-full px-5" onclick={() => openCreate()} disabled={isLoading}>
      Mark Teacher Absent
    </button>
  </header>

  <section class="card bg-base-100 shadow-sm border border-base-200">
    <div class="card-body">
      <div class="flex items-center justify-between mb-5">
        <div class="flex items-center gap-3">
          <button
            class="btn btn-sm btn-circle btn-ghost hover:bg-base-200"
            onclick={prevMonth}
            aria-label="Previous month">‹</button
          >
          <h2 class="text-xl font-bold tracking-tight w-44 text-center">{monthLabel}</h2>
          <button class="btn btn-sm btn-circle btn-ghost hover:bg-base-200" onclick={nextMonth} aria-label="Next month"
            >›</button
          >
        </div>
        <button class="btn btn-sm btn-ghost rounded-lg" onclick={goToday}>Today</button>
      </div>

      <div class="grid grid-cols-7 gap-2 mb-2">
        {#each WEEKDAY_LABELS as label}
          <div class="text-center text-[11px] font-semibold uppercase tracking-wider pb-1">
            {label}
          </div>
        {/each}
      </div>

      <div class="grid grid-cols-7 gap-2">
        {#each calendarDays as day}
          {@const key = formatDateKey(day.date)}
          {@const items = absencesMap.get(key) || []}
          {@const reasonsPresent = [...new Set(items.map((i) => i.reason))]}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="relative rounded-xl border overflow-hidden cursor-pointer min-h-[6.5rem] sm:min-h-[8rem] transition-all duration-150
            {day.inMonth ? '' : 'opacity-70'}
            {items.length
              ? 'border-base-200 bg-base-100 hover:border-base-300 hover:shadow-md'
              : 'bg-base-100 border-base-200 hover:border-base-300 hover:shadow-md'}
            {key === todayKey ? 'ring-2 ring-primary/60 ring-offset-2 ring-offset-base-100' : ''}"
            onclick={() => (items.length ? openDayList(day.date) : openCreate(day.date))}
          >
            <span
              class="absolute top-1.5 left-1.5 z-10 w-5 h-5 flex items-center justify-center rounded-full text-xs font-bold text-base-content/80
              {key === todayKey ? 'bg-primary text-primary-content' : ''}"
            >
              {day.date.getDate()}
            </span>

            {#if items.length}
              <div class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 pt-4">
                <span class="text-2xl font-extrabold text-base-content/80 leading-none">{items.length}</span>
                <span class="text-[10px] font-semibold uppercase tracking-wide text-base-content/40"
                  >{items.length === 1 ? 'absent' : 'absent'}</span
                >
                <div class="flex items-center gap-1">
                  {#each reasonsPresent as r}
                    {@const style = reasonStyle(r)}
                    <span class="w-1.5 h-1.5 rounded-full {style.dot}" title={r}></span>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </section>
</main>

{#if showDayModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal modal-open bg-black/50" onclick={(e) => e.target === e.currentTarget && (showDayModal = false)}>
    <div class="modal-box max-w-md p-6">
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-xl font-bold tracking-tight">{dayModalDate ? formatDateLong(dayModalDate) : ''}</h3>
        <button class="btn btn-sm btn-circle btn-ghost" onclick={() => (showDayModal = false)}>✕</button>
      </div>

      <div class="flex flex-col gap-2 max-h-72 overflow-y-auto">
        {#each dayModalItems as item}
          {@const style = reasonStyle(item.reason)}
          <button
            type="button"
            class="flex items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left transition-opacity hover:opacity-80 {style.bg}"
            onclick={() => {
              showDayModal = false
              openEdit(item)
            }}
          >
            <span class="flex items-center gap-2 min-w-0">
              <span class="w-1.5 h-1.5 rounded-full shrink-0 {style.dot}"></span>
              <span class="truncate text-sm font-semibold {style.text}">{teacherName(item)}</span>
            </span>
            <span class="text-xs font-medium {style.text} opacity-70 shrink-0">{item.reason}</span>
          </button>
        {/each}
      </div>

      <div class="modal-action mt-6">
        <button
          class="btn btn-info btn-soft w-full"
          onclick={() => {
            const d = dayModalDate
            showDayModal = false
            openCreate(d)
          }}
        >
          + Add Teacher
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal modal-open bg-black/50" onclick={(e) => e.target === e.currentTarget && (showModal = false)}>
    <div class="modal-box max-w-md p-6">
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-xl font-bold tracking-tight">{formData.id ? 'Edit Absence' : 'Mark Teacher Absent'}</h3>
        <button class="btn btn-sm btn-circle btn-ghost" onclick={() => (showModal = false)}>✕</button>
      </div>

      <div class="flex flex-col gap-4">
        {#if formData.id}
          <select class="select select-bordered w-full" bind:value={formData.teacher}>
            <option value="" disabled selected>Select teacher</option>
            {#each teachers as t}
              <option value={t.id}>{t[TEACHER_NAME_FIELD]}</option>
            {/each}
          </select>

          <select class="select select-bordered w-full" bind:value={formData.reason}>
            {#each REASON_OPTIONS as option}
              <option value={option}>{option}</option>
            {/each}
          </select>
        {:else}
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <span class="text-sm font-semibold text-base-content/70">Teacher(s) &amp; reason</span>
              {#if Object.keys(formData.selections).length}
                <span class="text-xs text-base-content/50">{Object.keys(formData.selections).length} selected</span>
              {/if}
            </div>
            <div class="border border-base-300 rounded-lg max-h-64 overflow-y-auto p-1.5 flex flex-col gap-0.5">
              {#each teachers as t}
                {@const selection = formData.selections[t.id]}
                <label
                  class="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm {selection !== undefined
                    ? 'bg-base-200/60'
                    : ''}"
                >
                  <input
                    type="checkbox"
                    class="checkbox checkbox-sm shrink-0"
                    checked={selection !== undefined}
                    onchange={() => toggleTeacher(t.id)}
                  />
                  <span class="flex-1 truncate">{t[TEACHER_NAME_FIELD]}</span>
                  {#if selection !== undefined}
                    <select
                      class="select select-bordered select-xs w-32 shrink-0"
                      value={selection}
                      onchange={(e) => setSelectionReason(t.id, e.target.value)}
                    >
                      {#each REASON_OPTIONS as option}
                        <option value={option}>{option}</option>
                      {/each}
                    </select>
                  {/if}
                </label>
              {/each}
            </div>
          </div>
        {/if}
        {#if !teachers.length}
          <p class="text-xs text-base-content/50 -mt-2">
            No teachers found in the "{TEACHERS_COLLECTION}" collection.
          </p>
        {/if}

        <input
          type="date"
          class="input input-bordered w-full"
          bind:value={formData.date}
          onkeypress={(e) => e.key === 'Enter' && saveAbsence()}
        />
      </div>

      <div class="modal-action mt-6 justify-between">
        {#if formData.id}
          <button
            class="btn btn-error btn-soft"
            onclick={() => {
              deleteAbsence({ id: formData.id, teacher: formData.teacher })
              showModal = false
            }}
          >
            Delete
          </button>
        {:else}
          <span></span>
        {/if}
        <div class="flex gap-2">
          <button class="btn btn-ghost btn-soft" onclick={() => (showModal = false)}>Cancel</button>
          <button class="btn btn-info btn-soft" onclick={saveAbsence}>
            {formData.id
              ? 'Update'
              : Object.keys(formData.selections).length > 1
                ? `Create (${Object.keys(formData.selections).length})`
                : 'Create'}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  :global(html) {
    overflow-y: scroll;
  }
  .calendar-shell {
    font-family: 'Inter', sans-serif;
  }
  .calendar-shell :global(h1),
  .calendar-shell :global(h2),
  .calendar-shell :global(h3) {
    font-family: 'Plus Jakarta Sans', sans-serif;
  }
</style>
