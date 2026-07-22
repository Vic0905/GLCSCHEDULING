<script>
  import { onDestroy, onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../lib/Pocketbase.svelte'

  let selectedDate = $state(new Date().toISOString().split('T')[0])
  let todayHoliday = $state(null)
  let isLoading = $state(false)
  let isRefreshing = $state(false)
  let teachers = $state([])
  let scheduleMap = $state(new Map())

  let unsubSchedule = null
  let unsubRoomType = null
  let unsubTeacher = null
  let debounceTimer = null

  let cachedTimeslots = []
  let cachedTeachers = []
  let cachedHolidays = []
  let cachedRoomTypes = []
  let teacherRoomMap = new Map()
  let periodNumberByTimeslotId = new Map()

  const today = () => new Date().toISOString().split('T')[0]

  // This week's Friday (max date for non-admin)
  const todayOne = new Date()
  const currentDay = todayOne.getDay() === 0 ? 7 : todayOne.getDay()
  const currentFriday = new Date(todayOne)
  currentFriday.setDate(todayOne.getDate() + (5 - currentDay))
  const maxFridayString = $derived(
    `${currentFriday.getFullYear()}-${String(currentFriday.getMonth() + 1).padStart(2, '0')}-${String(currentFriday.getDate()).padStart(2, '0')}`
  )

  function formatDateShort(dateStr) {
    return new Date(dateStr)
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      .toUpperCase()
  }

  function getRoomNumber(roomName) {
    if (!roomName) return Infinity
    const num = parseInt(roomName.replace(/\D/g, ''), 10)
    return isNaN(num) ? Infinity : num
  }

  const SUB_CLASS_TAG = 'Sub Class'
  function withoutSubClassTag(customSchedule) {
    return (customSchedule || []).filter((cs) => cs?.name !== SUB_CLASS_TAG)
  }

  // Same break/lunch detection used in the Teacher Daily View grid
  const BREAK_SCHEDULES = ['lunch break', 'break time', 'other task']
  function isBreakSchedule(cs) {
    return BREAK_SCHEDULES.includes(cs?.name?.toLowerCase().trim())
  }

  // Timeslots starting before 08:00 are prep slots — not counted in PERIOD numbering
  function computePeriodNumbers(timeslots) {
    const map = new Map()
    let counter = 0
    for (const ts of timeslots) {
      if (ts.start && ts.start < '08:00') {
        map.set(ts.id, null)
      } else {
        counter++
        map.set(ts.id, counter)
      }
    }
    return map
  }

  // customSchedule.color -> inline style, same formula used in the grid's badge/cell coloring
  function customScheduleStyle(cs) {
    if (!cs?.color) return ''
    return `background:${cs.color}20; color:${cs.color}; border-color:${cs.color}80;`
  }
  function remarkStyle(colorRemark) {
    if (!colorRemark) return ''
    return `background:${colorRemark}20; color:${colorRemark};`
  }

  // Loads timeslots, roomTypes, teachers, holidays — rebuilds teachers[] and teacherRoomMap
  async function loadStructure() {
    try {
      const [timeslots, roomTypes, allTeachers, holidays] = await Promise.all([
        pb.collection('timeslot').getFullList({ sort: 'start' }),
        pb.collection('roomType').getFullList({ sort: 'name', expand: 'teacher' }),
        pb.collection('teacher').getFullList({ sort: 'name', fields: 'id,name,status,user' }),
        pb.collection('holiday').getFullList({ fields: 'id,name,date' }),
      ])
      cachedTimeslots = timeslots
      periodNumberByTimeslotId = computePeriodNumbers(timeslots)
      cachedRoomTypes = roomTypes
      cachedTeachers = allTeachers
      cachedHolidays = holidays
      teacherRoomMap = new Map(
        roomTypes.filter((rt) => rt.expand?.teacher).map((rt) => [rt.expand.teacher.id, rt.name])
      )

      const isAdmin = pb.authStore.model?.role === 'admin'
      let visibleTeachers = isAdmin
        ? cachedTeachers.filter((t) => t.status !== 'disabled')
        : cachedTeachers.filter((t) => t.user === pb.authStore.model?.id)

      teachers = visibleTeachers.sort((a, b) => {
        const aRoom = teacherRoomMap.get(a.id)
        const bRoom = teacherRoomMap.get(b.id)
        if (aRoom && bRoom) return getRoomNumber(aRoom) - getRoomNumber(bRoom)
        if (aRoom && !bRoom) return -1
        if (!aRoom && bRoom) return 1
        return a.name.localeCompare(b.name)
      })
    } catch (err) {
      console.error(err)
      toast.error('Failed to load teacher data')
    }
  }

  // Only fetches schedules and rebuilds scheduleMap — does NOT touch teachers[]
  async function loadScheduleData() {
    if (isRefreshing) return
    isRefreshing = true
    try {
      const isAdmin = pb.authStore.model?.role === 'admin'
      const startStr = `${selectedDate} 00:00:00`
      const endStr = `${selectedDate} 23:59:59`

      todayHoliday = cachedHolidays.find((h) => h.date?.split(' ')[0] === selectedDate) ?? null

      let scheduleFilter = `date >= "${startStr}" && date <= "${endStr}" && status = "show"`
      if (!isAdmin)
        scheduleFilter += ` && (teacher.user = "${pb.authStore.model?.id}" || sub.user = "${pb.authStore.model?.id}")`
      let schedules = await pb.collection('dailySchedule').getFullList({
        filter: scheduleFilter,
        expand: 'teacher,sub,student,subject,room,timeslot,customSchedule',
      })

      if (todayHoliday) {
        schedules = schedules.filter((s) => s.date?.split(' ')[0] === selectedDate)
      }

      const newMap = new Map()
      const bookedTeacherIds = new Set()

      for (const s of schedules) {
        const originalTeacherId = s.expand?.teacher?.id
        const subTeacherId = s.expand?.sub?.id
        const timeslotId = s.expand?.timeslot?.id
        if (!originalTeacherId || !timeslotId) continue

        const studentList = Array.isArray(s.expand?.student)
          ? s.expand.student
          : s.expand?.student
            ? [s.expand.student]
            : []

        const rawCustomSchedule = s.expand?.customSchedule || []

        // Original teacher keeps the record, but without the "Sub Class" badge —
        // they're absent, someone else is covering it.
        bookedTeacherIds.add(originalTeacherId)
        if (!newMap.has(originalTeacherId)) newMap.set(originalTeacherId, new Map())
        const originalSlots = newMap.get(originalTeacherId)
        if (!originalSlots.has(timeslotId)) originalSlots.set(timeslotId, [])
        originalSlots.get(timeslotId).push({
          subject: s.expand?.subject,
          room: s.expand?.room,
          customSchedule: withoutSubClassTag(rawCustomSchedule),
          students: studentList,
        })

        // Sub teacher also sees the same record on their own row, tag intact,
        // so they know it's a class they're covering.
        if (subTeacherId) {
          bookedTeacherIds.add(subTeacherId)
          if (!newMap.has(subTeacherId)) newMap.set(subTeacherId, new Map())
          const subSlots = newMap.get(subTeacherId)
          if (!subSlots.has(timeslotId)) subSlots.set(timeslotId, [])
          subSlots.get(timeslotId).push({
            subject: s.expand?.subject,
            room: s.expand?.room,
            customSchedule: rawCustomSchedule,
            students: studentList,
          })
        }
      }

      scheduleMap = newMap

      // Admin: surface disabled teachers that have bookings today without replacing the full list
      if (isAdmin) {
        const disabledWithBookings = cachedTeachers.filter((t) => t.status === 'disabled' && bookedTeacherIds.has(t.id))
        if (disabledWithBookings.length) {
          const existingIds = new Set(teachers.map((t) => t.id))
          const toAdd = disabledWithBookings.filter((t) => !existingIds.has(t.id))
          if (toAdd.length) teachers = [...teachers, ...toAdd]
        }
      }
    } catch (err) {
      console.error(err)
      toast.error('Failed to load schedule data')
    } finally {
      isRefreshing = false
    }
  }

  // Full initial load
  async function initialLoad() {
    isLoading = true
    try {
      await loadStructure()
      await loadScheduleData()
    } finally {
      isLoading = false
    }
  }

  function debounceRefresh() {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(loadScheduleData, 500)
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

  function getDateFromUrl() {
    const hash = window.location.hash // "#/daily/views/teachertable?date=2026-06-25"
    const qIndex = hash.indexOf('?')
    if (qIndex === -1) return null
    return new URLSearchParams(hash.slice(qIndex + 1)).get('date')
  }

  onMount(async () => {
    const urlDate = getDateFromUrl()
    if (urlDate) selectedDate = urlDate // override the default before loading

    await initialLoad()
    unsubSchedule = await pb.collection('dailySchedule').subscribe('*', debounceRefresh)
    unsubRoomType = await pb.collection('roomType').subscribe('*', async () => {
      await loadStructure()
      await loadScheduleData()
    })
    unsubTeacher = await pb.collection('teacher').subscribe('*', async () => {
      await loadStructure()
      await loadScheduleData()
    })
  })

  onDestroy(() => {
    clearTimeout(debounceTimer)
    unsubSchedule?.()
    unsubRoomType?.()
    unsubTeacher?.()
  })
</script>

<div class="p-2 sm:p-4 md:p-6 bg-base-100 min-h-screen">
  <!-- INITIAL LOAD -->
  {#if isLoading}
    <div class="flex justify-center py-16">
      <span class="loading loading-spinner loading-lg text-primary"></span>
    </div>
  {:else if todayHoliday && teachers.length === 0}
    <div class="flex flex-col items-center justify-center py-20 gap-3 text-center">
      <span class="text-5xl">🎉</span>
      <h3 class="text-xl font-bold">{todayHoliday.name}</h3>
      <p class="text-sm text-base-content/50">No classes scheduled for this holiday.</p>
    </div>
  {:else if teachers.length === 0}
    <div class="flex flex-col items-center justify-center py-20 gap-2">
      <span class="text-4xl">📅</span>
      <p class="text-sm text-base-content/50">No active teachers for this date.</p>
    </div>
  {:else}
    <div class="flex flex-col gap-8">
      {#each teachers as teacher (teacher.id)}
        {@const slots = scheduleMap.get(teacher.id)}

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
              TEACHER'S SCHEDULE
            </h3>

            <!-- RIGHT: controls -->
            <div class="flex items-center gap-2 justify-end w-48">
              <button
                class="btn btn-xs btn-ghost btn-outline rounded-full px-3"
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

          <!-- TEACHER INFO ROW -->
          <div class="flex flex-col sm:flex-row border-b-2 border-base-300 sm:divide-x-2 sm:divide-base-300">
            <div class="flex flex-col gap-1 px-4 py-2 flex-1 min-w-0 border-b border-base-300 sm:border-b-0">
              <span class="text-[10px] font-bold uppercase tracking-widest text-base-content/50">Name:</span>
              <span class="text-base font-bold truncate">{teacher.name || '—'}</span>
            </div>
            <div class="flex flex-col gap-1 px-4 py-2 flex-1 min-w-0 border-b border-base-300 sm:border-b-0">
              <span class="text-[10px] font-bold uppercase tracking-widest text-base-content/50">Assigned Room:</span>
              <span class="text-base font-bold truncate">{teacherRoomMap.get(teacher.id) || '—'}</span>
            </div>
            <div class="flex flex-col gap-1 px-4 py-2 flex-1 min-w-0 border-b border-base-300 sm:border-b-0">
              <span class="text-[10px] font-bold uppercase tracking-widest text-base-content/50">Date:</span>
              <span class="text-base font-bold text-error">{formatDateShort(selectedDate)}</span>
            </div>
          </div>

          <!-- STATUS ROW (disabled badge) -->
          {#if teacher.status === 'disabled'}
            <div class="flex items-center gap-2 px-4 py-1.5 bg-base-200 border-b border-base-300">
              <span class="badge badge-error badge-sm">Disabled</span>
            </div>
          {/if}

          <!-- SCHEDULE TABLE -->
          <div class="overflow-x-auto">
            <table class="table table-xs sm:table-sm w-full min-w-[780px] border-collapse">
              <colgroup>
                <col class="w-10" />
                <col class="w-50" />
                <col class="w-50" />
                <col class="w-100" />
                <col class="w-100" />
                <col class="w-50" />
                <col class="w-50" />
                <col class="w-50" />
              </colgroup>
              <thead class="text-center border border-neutral-focus py-3">
                <tr class="bg-neutral text-neutral-content text-xs tracking-widest h-10">
                  <th>PERIOD</th>
                  <th>TIME</th>
                  <th>ROOM</th>
                  <th>SUBJECT</th>
                  <th>STUDENTS</th>
                  <th>LEVEL</th>
                  <th>MEMO</th>
                  <th>REMARKS</th>
                </tr>
              </thead>
              <tbody>
                {#each cachedTimeslots as ts, i}
                  {@const entries = slots?.get(ts.id) || []}
                  <tr class="{i % 2 === 0 ? 'bg-base-100' : 'bg-base-200'} hover:bg-base-300 transition-colors">
                    <td class="text-center font-extrabold text-base border border-base-900 bg-base-200">
                      {periodNumberByTimeslotId.get(ts.id) ?? '-'}
                    </td>
                    <td class="text-center font-semibold text-sm border border-base-900 whitespace-nowrap"
                      >{ts.start} - {ts.end}</td
                    >
                    <td class="text-center text-sm font-bold border border-base-900">
                      {#if entries.length}
                        <div class="flex flex-col gap-0.5">
                          {#each entries as e}<span>{e.room?.name || '—'}</span>{/each}
                        </div>
                      {:else}
                        <span>—</span>
                      {/if}
                    </td>
                    <td class="text-center text-sm font-semibold border border-base-900">
                      {#if entries.length}
                        <div class="flex flex-col gap-0.5">
                          {#each entries as e}<span>{e.subject?.name || '—'}</span>{/each}
                        </div>
                      {:else}
                        <span>—</span>
                      {/if}
                    </td>
                    <td class="text-center text-sm border border-base-900">
                      {#if entries.length}
                        <div class="flex flex-col gap-1 py-1">
                          {#each entries as e}
                            <div class="flex flex-wrap justify-center gap-1">
                              {#each e.students as s}
                                <span class="font-semibold">{s.englishName || s.name}</span>
                              {/each}
                            </div>
                          {/each}
                        </div>
                      {:else}
                        <span>—</span>
                      {/if}
                    </td>
                    <td class="text-center text-sm font-semibold border border-base-900">
                      {#if entries.length}
                        <div class="flex flex-col gap-1 py-1">
                          {#each entries as e}
                            <div class="flex flex-wrap justify-center gap-1">
                              {#each e.students as s}
                                <span>{s.level || '—'}</span>
                              {/each}
                            </div>
                          {/each}
                        </div>
                      {:else}
                        <span>—</span>
                      {/if}
                    </td>
                    <td class="text-center text-sm font-bold border border-base-900">
                      {#if entries.length}
                        <div class="flex flex-col gap-1 items-center py-1">
                          {#each entries as e}
                            {#if e.customSchedule?.length}
                              <div class="flex flex-wrap justify-center gap-1">
                                {#each e.customSchedule as cs}
                                  <span
                                    class="text-lg {isBreakSchedule(cs) ? 'font-bold tracking-wide' : ''}"
                                    style={customScheduleStyle(cs)}
                                  >
                                    {isBreakSchedule(cs) ? cs.name.toUpperCase() : cs.name}
                                  </span>
                                {/each}
                              </div>
                            {:else}
                              <span>—</span>
                            {/if}
                          {/each}
                        </div>
                      {:else}
                        <span>—</span>
                      {/if}
                    </td>
                    <td class="text-center text-sm font-bold border border-base-900">
                      {#if entries.length}
                        <div class="flex flex-col gap-1 py-1">
                          {#each entries as e}
                            <div class="flex flex-wrap justify-center gap-1">
                              {#each e.students as s}
                                <span style={remarkStyle(s.colorRemark)}>{s.remarks || '—'}</span>
                              {/each}
                            </div>
                          {/each}
                        </div>
                      {:else}
                        <span>—</span>
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
