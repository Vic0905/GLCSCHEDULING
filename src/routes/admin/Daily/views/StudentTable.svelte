<script>
  import { onDestroy, onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../lib/Pocketbase.svelte'

  let selectedDate = $state(new Date().toISOString().split('T')[0])
  let todayHoliday = $state(null)
  let isLoading = $state(false)
  let isRefreshing = $state(false)
  let students = $state([])
  let scheduleMap = $state(new Map())

  let unsubSchedule = null
  let debounceTimer = null

  let cachedTimeslots = $state([])
  let cachedHolidays = $state([])

  const today = () => new Date().toISOString().split('T')[0]

  function formatDateShort(dateStr) {
    return new Date(dateStr)
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      .toUpperCase()
  }

  // Loads timeslots and holidays — rebuilds students[]
  async function loadStructure() {
    try {
      const [timeslots, holidays] = await Promise.all([
        pb.collection('timeslot').getFullList({ sort: 'start' }),
        pb.collection('holiday').getFullList({ fields: 'id,name,date' }),
      ])
      cachedTimeslots = timeslots
      cachedHolidays = holidays

      const isAdmin = pb.authStore.model?.role === 'admin'
      const startStr = `${selectedDate} 00:00:00`
      const endStr = `${selectedDate} 23:59:59`

      let studentFilter = `status != "graduated" && start <= "${endStr}" && end >= "${startStr}"`
      if (!isAdmin) studentFilter += ` && user = "${pb.authStore.model?.id}"`
      const fetchedStudents = await pb.collection('student').getFullList({ filter: studentFilter })

      const latestByName = new Map()
      for (const s of fetchedStudents) {
        const key = s.englishName?.toLowerCase()
        if (!key) continue
        if (!latestByName.has(key) || new Date(s.created) > new Date(latestByName.get(key).created)) {
          latestByName.set(key, s)
        }
      }

      students = [...latestByName.values()].sort((a, b) => {
        const aIsNew = a.status === 'new' ? 1 : 0
        const bIsNew = b.status === 'new' ? 1 : 0
        return aIsNew !== bIsNew ? aIsNew - bIsNew : new Date(a.created) - new Date(b.created)
      })
    } catch (err) {
      console.error(err)
      toast.error('Failed to load student data')
    }
  }

  // Only fetches schedules and rebuilds scheduleMap — does NOT touch students[]
  async function loadScheduleData() {
    if (isRefreshing) return
    isRefreshing = true
    try {
      const isAdmin = pb.authStore.model?.role === 'admin'
      const startStr = `${selectedDate} 00:00:00`
      const endStr = `${selectedDate} 23:59:59`

      todayHoliday = cachedHolidays.find((h) => h.date?.split(' ')[0] === selectedDate) ?? null

      let scheduleFilter = `date >= "${startStr}" && date <= "${endStr}" && status = "show"`
      if (!isAdmin) scheduleFilter += ` && student.user = "${pb.authStore.model?.id}"`
      let schedules = await pb.collection('dailySchedule').getFullList({
        filter: scheduleFilter,
        expand: 'teacher,student,subject,room,timeslot',
      })

      if (todayHoliday) {
        schedules = schedules.filter((s) => s.date?.split(' ')[0] === selectedDate)
      }

      const newMap = new Map()
      for (const s of schedules) {
        const timeslotId = s.expand?.timeslot?.id
        if (!timeslotId) continue
        const entry = {
          subject: s.expand?.subject,
          teacher: s.expand?.teacher,
          room: s.expand?.room,
        }
        const studentList = Array.isArray(s.expand?.student)
          ? s.expand.student
          : s.expand?.student
            ? [s.expand.student]
            : []

        for (const student of studentList) {
          if (!newMap.has(student.id)) newMap.set(student.id, new Map())
          const slots = newMap.get(student.id)
          if (!slots.has(timeslotId)) slots.set(timeslotId, [])
          slots.get(timeslotId).push({ ...entry, remarks: student.remarks })
        }
      }
      scheduleMap = newMap
    } catch (err) {
      console.error(err)
      toast.error('Failed to load student schedule')
    } finally {
      isRefreshing = false
    }
  }

  async function initialLoad() {
    isLoading = true
    try {
      await loadStructure()
      await loadScheduleData()
    } finally {
      isLoading = false
    }
  }

  function debounceRefresh(e) {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(loadScheduleData, 500)

    if (e?.action === 'create') toast.success('Schedule created')
    else if (e?.action === 'update') toast.info('Schedule updated')
    else if (e?.action === 'delete') toast.warning('Schedule deleted')
  }

  const changeDay = async (days) => {
    if (isRefreshing) return
    const d = new Date(selectedDate)
    d.setDate(d.getDate() + days)
    selectedDate = d.toISOString().split('T')[0]
    await loadScheduleData()
  }

  const onDateChange = async (e) => {
    if (isRefreshing) return
    selectedDate = e.target.value
    await loadScheduleData()
  }

  const goToToday = async () => {
    if (isRefreshing || selectedDate === today()) return
    selectedDate = today()
    await loadScheduleData()
  }

  onMount(async () => {
    await initialLoad()
    unsubSchedule = await pb.collection('dailySchedule').subscribe('*', debounceRefresh)
  })

  onDestroy(() => {
    clearTimeout(debounceTimer)
    unsubSchedule?.()
  })
</script>

<div class="p-2 sm:p-4 md:p-6 bg-base-100 min-h-screen">
  <!-- INITIAL LOAD -->
  {#if isLoading}
    <div class="flex justify-center py-16">
      <span class="loading loading-spinner loading-lg text-primary"></span>
    </div>
  {:else if todayHoliday && students.length === 0}
    <div class="flex flex-col items-center justify-center py-20 gap-3 text-center">
      <span class="text-5xl">🎉</span>
      <h3 class="text-xl font-bold">{todayHoliday.name}</h3>
      <p class="text-sm text-base-content/50">No classes scheduled for this holiday.</p>
    </div>
  {:else if students.length === 0}
    <div class="flex flex-col items-center justify-center py-20 gap-2">
      <span class="text-4xl">📅</span>
      <p class="text-sm text-base-content/50">No active students for this date.</p>
    </div>
  {:else}
    <div class="flex flex-col gap-8">
      {#each students as student (student.id)}
        {@const slots = scheduleMap.get(student.id)}

        <div class="border-2 border-base-300 rounded-lg overflow-hidden bg-base-100 shadow-sm">
          <!-- HEADER: holiday left | title center | controls right -->
          <div class="flex items-center gap-2 px-4 py-4 border-b-2 border-base-300 bg-base-100">
            <!-- LEFT: holiday badge -->
            <div class="flex items-center min-w-0 w-48">
              {#if todayHoliday}
                <span
                  class="flex items-center gap-1.5 text-yellow-800 border border-yellow-300 bg-yellow-50 rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap"
                >
                  <span>🎉</span>
                  {todayHoliday.name}
                </span>
              {/if}
            </div>

            <!-- CENTER: title -->
            <h3 class="flex-1 text-xl font-extrabold tracking-widest text-center whitespace-nowrap">
              STUDENT'S SCHEDULE
            </h3>

            <!-- RIGHT: controls -->
            <div class="flex items-center gap-2 justify-end w-48">
              <button
                class="btn btn-xs btn-primary btn-outline rounded-full px-3"
                onclick={goToToday}
                disabled={isRefreshing || selectedDate === today()}>Today</button
              >

              <div class="join">
                <button
                  class="join-item btn btn-xs btn-ghost border border-base-300"
                  onclick={() => changeDay(-1)}
                  disabled={isRefreshing}>&larr;</button
                >
                <input
                  type="date"
                  class="join-item input input-bordered input-xs w-32"
                  value={selectedDate}
                  onchange={onDateChange}
                  disabled={isRefreshing}
                />
                <button
                  class="join-item btn btn-xs btn-ghost border border-base-300"
                  onclick={() => changeDay(1)}
                  disabled={isRefreshing}>&rarr;</button
                >
              </div>

              {#if isRefreshing}
                <span class="loading loading-spinner loading-xs text-primary"></span>
              {/if}
            </div>
          </div>

          <!-- STUDENT INFO ROW -->
          <div class="flex flex-col sm:flex-row border-b-2 border-base-300 sm:divide-x-2 sm:divide-base-300">
            <div class="flex flex-col gap-1 px-4 py-2 flex-1 min-w-0 border-b border-base-300 sm:border-b-0">
              <span class="text-[10px] font-bold uppercase tracking-widest text-base-content/50">Name:</span>
              <span class="text-base font-bold truncate">{student.name || '—'}</span>
            </div>
            <div class="flex flex-col gap-1 px-4 py-2 flex-1 min-w-0 border-b border-base-300 sm:border-b-0">
              <span class="text-[10px] font-bold uppercase tracking-widest text-base-content/50">English Name:</span>
              <span class="text-base font-bold truncate">{student.englishName || '—'}</span>
            </div>
            <div class="flex flex-col gap-1 px-4 py-2 flex-1 min-w-0 border-b border-base-300 sm:border-b-0">
              <span class="text-[10px] font-bold uppercase tracking-widest text-base-content/50">Date:</span>
              <span class="text-base font-bold text-error">{formatDateShort(selectedDate)}</span>
            </div>
          </div>

          <!-- STATUS ROW -->
          {#if student.status !== 'old'}
            <div class="flex items-center gap-2 px-4 py-1.5 bg-base-200 border-b border-base-300">
              {#if student.status === 'new'}<span class="badge badge-success badge-sm">New</span>{/if}
              {#if student.status === 'extended'}<span class="badge badge-secondary badge-sm">Extended</span>{/if}
              {#if student.status === 'changed'}<span class="badge badge-error badge-sm">Changed</span>{/if}
              {#if student.course || student.level}
                <span class="text-xs text-base-content/50"
                  >{student.course || ''}{student.level ? ` · ${student.level}` : ''}</span
                >
              {/if}
            </div>
          {/if}

          <!-- SCHEDULE TABLE -->
          <div class="overflow-x-auto">
            <table class="table table-xs sm:table-sm w-full min-w-[680px] border-collapse">
              <colgroup>
                <col class="w-30" />
                <col class="w-100" />
                <col class="w-100" />
                <col class="w-100" />
                <col class="w-100" />
                <col />
              </colgroup>
              <thead class="text-center border border-neutral-focus py-3">
                <tr class="bg-neutral text-neutral-content text-xs tracking-widest h-10">
                  <th>PERIOD</th>
                  <th>TIME</th>
                  <th>TEACHER</th>
                  <th>CUBICLE / ROOM</th>
                  <th>SUBJECT</th>
                  <th>REMARKS</th>
                </tr>
              </thead>
              <tbody>
                {#each cachedTimeslots as ts, i}
                  {@const entries = slots?.get(ts.id) || []}
                  <tr class="{i % 2 === 0 ? 'bg-base-100' : 'bg-base-200'} hover:bg-base-300 transition-colors">
                    <td class="text-center font-extrabold text-base border border-base-300 bg-base-200">{i + 1}</td>
                    <td class="text-center font-semibold text-sm border border-base-300 whitespace-nowrap"
                      >{ts.start} - {ts.end}</td
                    >
                    <td class="text-center font-bold text-sm border border-base-300">
                      {#if entries.length}
                        <div class="flex flex-col gap-0.5">
                          {#each entries as e}<span>{e.teacher?.name || '—'}</span>{/each}
                        </div>
                      {:else}
                        <span class="text-base-content/20">—</span>
                      {/if}
                    </td>
                    <td class="text-center font-bold text-sm border border-base-300">
                      {#if entries.length}
                        <div class="flex flex-col gap-0.5">
                          {#each entries as e}<span>{e.room?.name || '—'}</span>{/each}
                        </div>
                      {:else}
                        <span class="text-base-content/20">—</span>
                      {/if}
                    </td>
                    <td class="text-center text-sm font-semibold border border-base-300">
                      {#if entries.length}
                        <div class="flex flex-col gap-0.5">
                          {#each entries as e}<span>{e.subject?.name || '—'}</span>{/each}
                        </div>
                      {:else}
                        <span class="text-base-content/20">—</span>
                      {/if}
                    </td>
                    <td class="text-center text-sm font-bold border border-base-300">
                      {#if entries.length}
                        <div class="flex flex-col gap-0.5">
                          {#each entries as e}<span>{e.remarks || '—'}</span>{/each}
                        </div>
                      {:else}
                        <span class="text-base-content/20">—</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
