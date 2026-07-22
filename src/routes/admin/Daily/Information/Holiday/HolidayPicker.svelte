<script>
  import { toast } from 'svelte-sonner'
  import { onMount } from 'svelte'
  import { pb } from '../../../../../lib/Pocketbase.svelte'

  // --- State ---
  let specialDays = $state([])
  let isLoading = $state(false)
  let showModal = $state(false)
  let deleteConfirm = $state({ show: false, item: null })
  let clearConfirm = $state({ show: false, count: 0, dateStr: null, resolve: null })
  let currentMonth = $state(new Date(new Date().getFullYear(), new Date().getMonth(), 1))

  let formData = $state({
    id: null,
    name: '',
    date: '',
    status: 'No Class',
  })

  const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  function formatDateKey(date) {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  const todayKey = formatDateKey(new Date())

  // Softer, more legible palette per status (bg tint / text / dot accent)
  function statusStyle(status) {
    if (status === 'No Class') {
      return { bg: 'bg-[#FDECEA]', text: 'text-[#C0392B]', dot: 'bg-[#E4574B]' }
    }
    if (status === 'Special Class') {
      return { bg: 'bg-[#FFF5DE]', text: 'text-[#8A5A00]', dot: 'bg-[#E9B949]' }
    }
    return { bg: 'bg-[#E6F5EF]', text: 'text-[#146C51]', dot: 'bg-[#2FA98C]' } // Weekend Activity
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

  let specialDaysMap = $derived.by(() => {
    const map = new Map()
    for (const item of specialDays) {
      const key = formatDateKey(new Date(item.date))
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(item)
    }
    return map
  })

  let monthLabel = $derived(currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))

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
  async function loadSpecialDays() {
    if (isLoading) return

    isLoading = true
    try {
      const records = await pb.collection('holiday').getFullList({ sort: '-created' })
      specialDays = records.sort((a, b) => new Date(a.date) - new Date(b.date))
    } catch (err) {
      console.error('Load failed:', err)
      toast.error('Failed to load special days')
    } finally {
      isLoading = false
    }
  }

  // --- Batch-delete existing dailySchedule records for a date (mirrors "Clear Day") ---
  async function clearSchedulesForDate(dateStr) {
    try {
      const records = await pb.collection('dailySchedule').getFullList({
        filter: `date >= "${dateStr} 00:00:00" && date <= "${dateStr} 23:59:59"`,
        fields: 'id,date,room,timeslot',
      })

      if (!records.length) return

      const ok = await new Promise((resolve) => {
        clearConfirm = { show: true, count: records.length, dateStr, resolve }
      })
      if (!ok) return

      const b = pb.createBatch()
      records.forEach((r) => b.collection('dailySchedule').delete(r.id))
      await b.send()

      try {
        await pb.collection('activityLog').create({
          action: 'clear',
          performedBy: pb.authStore.record?.id,
          targetId: dateStr,
          details: {
            rangeStart: dateStr,
            rangeEnd: dateStr,
            roomType: 'all',
            count: records.length,
          },
        })
      } catch (err) {
        console.error('Failed to write activity log:', err)
      }

      toast.success(`Cleared ${records.length} schedule${records.length === 1 ? '' : 's'} from ${dateStr}`)
    } catch (err) {
      console.error('Failed to clear schedules for date:', err)
      toast.error('Failed to clear existing schedules for this date')
    }
  }

  function resolveClearConfirm(value) {
    clearConfirm.resolve?.(value)
    clearConfirm = { show: false, count: 0, dateStr: null, resolve: null }
  }

  // --- Save (Create/Update) ---
  async function saveSpecialDay() {
    const name = formData.name.trim()
    const date = formData.date
    const status = formData.status // capture before formData resets below

    if (!name || !date) {
      toast.error('Please fill in all fields')
      return
    }

    const exists = specialDays.find((d) => d.name.toLowerCase() === name.toLowerCase() && d.id !== formData.id)
    if (exists) {
      toast.error('Entry already exists')
      return
    }

    try {
      if (formData.id) {
        await pb.collection('holiday').update(formData.id, {
          name,
          date,
          Status: status,
        })
        toast.success('Updated')
      } else {
        await pb.collection('holiday').create({
          name,
          date,
          Status: status,
        })
        toast.success('Created')
      }

      showModal = false
      formData = {
        id: null,
        name: '',
        date: '',
        status: 'No Class',
      }

      await clearSchedulesForDate(date)
      await loadSpecialDays()
    } catch (err) {
      console.error('Save failed:', err)
      toast.error('Save failed')
    }
  }

  // --- Delete ---
  function requestDelete(item) {
    deleteConfirm = { show: true, item }
  }

  async function confirmDelete() {
    const item = deleteConfirm.item
    if (!item) return
    deleteConfirm = { show: false, item: null }

    try {
      await pb.collection('holiday').delete(item.id)
      toast.success('Deleted')
      await loadSpecialDays()
    } catch (err) {
      console.error('Delete failed:', err)
      toast.error('Delete failed')
    }
  }

  // --- UI Helpers ---
  function openEdit(item) {
    formData = {
      id: item.id,
      name: item.name,
      date: formatDateKey(new Date(item.date)),
      status: item.Status || 'No Class',
    }
    showModal = true
  }

  function openCreate(dateObj) {
    formData = {
      id: null,
      name: '',
      date: dateObj ? formatDateKey(dateObj) : '',
      status: 'No Class',
    }
    showModal = true
  }

  onMount(() => {
    loadSpecialDays()
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
      <h1 class="text-3xl font-extrabold tracking-tight text-base-content">Special Days</h1>
      <p class="text-sm text-base-content/50 mt-1">Manage holidays, no-class days, and weekends</p>
      <p class="text-sm text-base-content/40 mt-1 h-5 transition-opacity {isLoading ? 'opacity-100' : 'opacity-0'}">
        Loading…
      </p>
    </div>
    <button class="btn btn-info opacity-80 rounded-full px-5" onclick={() => openCreate()} disabled={isLoading}>
      Add Special Day
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
          {@const items = specialDaysMap.get(key) || []}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="relative rounded-xl border overflow-hidden cursor-pointer min-h-[6.5rem] sm:min-h-[8rem] transition-all duration-150
            {day.inMonth ? '' : 'opacity-70'}
            {items.length ? 'border-transparent' : 'bg-base-100 border-base-200 hover:border-base-300 hover:shadow-md'}
            {key === todayKey ? 'ring-2 ring-primary/60 ring-offset-2 ring-offset-base-100' : ''}"
            onclick={() => openCreate(day.date)}
          >
            <span
              class="absolute top-1.5 left-1.5 z-10 w-5 h-5 flex items-center justify-center rounded-full text-xs font-bold
              {items.length ? 'bg-base-100/85 text-base-content shadow-sm' : 'text-base-content/80'}
              {key === todayKey && !items.length ? 'bg-primary text-primary-content' : ''}"
            >
              {day.date.getDate()}
            </span>

            {#if items.length}
              <div class="absolute inset-0 flex flex-col divide-y divide-base-100/90">
                {#each items as item}
                  {@const style = statusStyle(item.Status)}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    class="flex-1 min-h-0 flex items-center justify-center gap-1.5 px-2 pt-6 pb-1.5 {style.bg}"
                    onclick={(e) => {
                      e.stopPropagation()
                      openEdit(item)
                    }}
                  >
                    <span class="w-1.5 h-1.5 rounded-full shrink-0 {style.dot}"></span>
                    <span class="truncate text-[11px] font-semibold tracking-tight {style.text}">{item.name}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </section>
</main>

{#if showModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal modal-open bg-black/50" onclick={(e) => e.target === e.currentTarget && (showModal = false)}>
    <div class="modal-box max-w-md p-6">
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-xl font-bold tracking-tight">{formData.id ? 'Edit Special Day' : 'Add Special Day'}</h3>
        <button class="btn btn-sm btn-circle btn-ghost" onclick={() => (showModal = false)}>✕</button>
      </div>

      <div class="flex flex-col gap-4">
        <input
          type="text"
          class="input input-bordered w-full"
          bind:value={formData.name}
          placeholder="Name (e.g., Christmas, Foundation Day)"
          onkeypress={(e) => e.key === 'Enter' && saveSpecialDay()}
        />

        <select class="select select-bordered w-full" bind:value={formData.status}>
          <option value="No Class">No Class</option>
          <option value="Special Class">Special Class</option>
          <option value="Weekend Activity">Weekend Activity</option>
        </select>

        <input
          type="date"
          class="input input-bordered w-full"
          bind:value={formData.date}
          onkeypress={(e) => e.key === 'Enter' && saveSpecialDay()}
        />
      </div>

      <div class="modal-action mt-6 justify-between">
        {#if formData.id}
          <button
            class="btn btn-error btn-soft"
            onclick={() => {
              showModal = false
              requestDelete({ id: formData.id, name: formData.name })
            }}
          >
            Delete
          </button>
        {:else}
          <span></span>
        {/if}
        <div class="flex gap-2">
          <button class="btn btn-ghost btn-soft" onclick={() => (showModal = false)}>Cancel</button>
          <button class="btn btn-info btn-soft" onclick={saveSpecialDay}>
            {formData.id ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if deleteConfirm.show}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="modal modal-open bg-black/50"
    onclick={(e) => e.target === e.currentTarget && (deleteConfirm = { show: false, item: null })}
  >
    <div class="modal-box max-w-sm p-6">
      <h3 class="text-lg font-bold tracking-tight">Delete special day?</h3>
      <p class="text-sm text-base-content/60 mt-2">
        This will permanently delete
        <span class="font-semibold text-base-content">"{deleteConfirm.item?.name}"</span>. This can't be undone.
      </p>
      <div class="modal-action mt-6">
        <button class="btn btn-ghost btn-soft" onclick={() => (deleteConfirm = { show: false, item: null })}>
          Cancel
        </button>
        <button class="btn btn-error" onclick={confirmDelete}>Delete</button>
      </div>
    </div>
  </div>
{/if}

{#if clearConfirm.show}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal modal-open bg-black/50" onclick={(e) => e.target === e.currentTarget && resolveClearConfirm(false)}>
    <div class="modal-box max-w-sm p-6">
      <h3 class="text-lg font-bold tracking-tight">
        Replace existing schedule{clearConfirm.count === 1 ? '' : 's'}?
      </h3>
      <p class="text-sm text-base-content/60 mt-2">
        {clearConfirm.count} schedule{clearConfirm.count === 1 ? '' : 's'} already exist{clearConfirm.count === 1
          ? 's'
          : ''} on {clearConfirm.dateStr}. Delete {clearConfirm.count === 1 ? 'it' : 'them'} to make room for the new schedule?
      </p>
      <div class="modal-action mt-6">
        <button class="btn btn-ghost btn-soft" onclick={() => resolveClearConfirm(false)}>Cancel</button>
        <button class="btn btn-error" onclick={() => resolveClearConfirm(true)}>Delete</button>
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
