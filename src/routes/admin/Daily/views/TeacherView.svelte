<script>
  import { onDestroy, onMount, tick } from 'svelte'
  import { Grid, h } from 'gridjs'
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../lib/Pocketbase.svelte'
  //   import { pb } from '../../../lib/Pocketbase.svelte'

  // --- State Runes ---
  let selectedDate = $state(getTodayDate())
  let todayHoliday = $state(null)
  let isLoading = $state(false)
  let gridInstance = $state(null)

  // Cached data
  let cachedTimeslots = $state([])
  let cachedTeachers = $state([])
  let cachedRooms = $state([])
  let cachedHolidays = $state([])
  let teacherRoomMap = $state(new Map())

  // Real-time subscriptions
  let unsubSchedule = null
  let unsubRoomType = null
  let unsubTeacher = null
  let scheduleMap = new Map()

  // --- Helper Functions ---
  function getTodayDate() {
    return new Date().toISOString().split('T')[0]
  }

  function formatDateDisplay(dateStr) {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  }

  function getRoomSortKey(roomName) {
    if (!roomName) return { tier: 99, num: Infinity }
    const upper = roomName.toUpperCase()

    let tier
    if (upper.startsWith('ST'))
      tier = 1 // MTM: ST01–ST12
    else if (upper.startsWith('A'))
      tier = 0 // MTM: A001–A157
    else if (upper.startsWith('B'))
      tier = 2 // MTM: B01–B20
    else if (upper.startsWith('G'))
      tier = 3 // GRP: G01–G26
    else if (upper.startsWith('H'))
      tier = 4 // GRP: H01–H16
    else tier = 5 // unknown room prefix

    const num = parseInt(upper.replace(/\D/g, ''), 10)
    return { tier, num: isNaN(num) ? Infinity : num }
  }

  const changeDay = async (days) => {
    const wrapper = document.querySelector('#teacher-grid .gridjs-wrapper')
    const savedScrollTop = wrapper?.scrollTop || 0
    const savedScrollLeft = wrapper?.scrollLeft || 0

    const d = new Date(selectedDate)
    d.setDate(d.getDate() + days)
    selectedDate = d.toISOString().split('T')[0]

    await loadTeacherSchedule(savedScrollTop, savedScrollLeft)
  }

  const onDateChange = async (e) => {
    const wrapper = document.querySelector('#teacher-grid .gridjs-wrapper')
    const savedScrollTop = wrapper?.scrollTop || 0
    const savedScrollLeft = wrapper?.scrollLeft || 0

    selectedDate = e.target.value
    await loadTeacherSchedule(savedScrollTop, savedScrollLeft)
  }

  const goToToday = async () => {
    const wrapper = document.querySelector('#teacher-grid .gridjs-wrapper')
    const savedScrollTop = wrapper?.scrollTop || 0
    const savedScrollLeft = wrapper?.scrollLeft || 0

    selectedDate = getTodayDate()
    await loadTeacherSchedule(savedScrollTop, savedScrollLeft)
  }

  // Format cell for teacher view - shows students and room
  const formatCell = (cell) => {
    const bgClass = cell?.bgClass || 'bg-white'

    if (!cell || !cell.schedules || cell.schedules.length === 0) {
      return h(
        'div',
        { class: `w-full h-full min-h-[55px] flex items-center justify-center text-gray-400 ${bgClass}` },
        '—'
      )
    }

    const { schedules } = cell
    const firstSched = schedules[0]

    // Break check
    const BREAK_SCHEDULES = ['lunch break', 'break time', 'other task']
    const customSchedules = firstSched?.customSchedule || []
    const breakSchedule = customSchedules.find((cs) => BREAK_SCHEDULES.includes(cs?.name?.toLowerCase().trim()))

    if (breakSchedule) {
      const style = breakSchedule.color
        ? `background:${breakSchedule.color}20; color:${breakSchedule.color};`
        : 'background:#f3f4f6; color:#6b7280;'
      return h(
        'div',
        {
          class: `w-full h-full min-h-[55px] flex items-center justify-center font-bold text-sm tracking-wide ${bgClass}`,
          style,
        },
        breakSchedule.name.toUpperCase()
      )
    }

    const subjectName = firstSched.subject?.name || 'No Subject'
    const roomName = firstSched.roomName || 'No Room'
    const allStudents = schedules.flatMap((s) => s.students.map((std) => std.name))

    return h(
      'div',
      { class: `flex flex-col gap-1 p-2 items-center justify-center text-center w-full h-full ${bgClass}` },
      [
        h('div', { class: 'font-bold border-b border-neutral-500 mb-1 pb-1 w-full' }, [
          h('div', {}, subjectName),
          h('div', { class: 'text-xs uppercase mt-1' }, roomName),
        ]),
        h(
          'div',
          { class: 'flex flex-wrap justify-center gap-1' },
          allStudents.map((name) => h('span', { class: 'text-xs font-semibold whitespace-nowrap' }, name))
        ),
        ...(customSchedules.length
          ? [
              h(
                'div',
                { class: 'flex flex-wrap justify-center gap-1 w-full mt-1' },
                customSchedules.map((cs) =>
                  h(
                    'span',
                    {
                      class: 'text-xs font-bold',
                      style: cs.color ? `background:${cs.color}20; color:${cs.color}; border-color:${cs.color}80;` : '',
                    },
                    cs.name || 'Custom'
                  )
                )
              ),
            ]
          : []),
      ]
    )
  }

  async function loadStaticData() {
    try {
      const [timeslots, roomTypes, teachers, holidays] = await Promise.all([
        pb.collection('timeslot').getFullList({ sort: 'start' }),
        pb.collection('roomType').getFullList({ sort: 'name', expand: 'teacher' }),
        pb.collection('teacher').getFullList({ sort: 'name', fields: 'id,name,status' }),
        pb.collection('holiday').getFullList({ fields: 'id,name,date' }),
      ])

      cachedTimeslots = timeslots
      cachedTeachers = teachers
      cachedRooms = roomTypes
      cachedHolidays = holidays

      // Create map of teacher ID to room name
      teacherRoomMap = new Map(
        roomTypes.filter((rt) => rt.expand?.teacher).map((rt) => [rt.expand.teacher.id, rt.name])
      )
    } catch (err) {
      console.error('Failed to load static data:', err)
      toast.error('Failed to load teacher/room data')
    }
  }

  async function loadTeacherSchedule(savedScrollTop = null, savedScrollLeft = null) {
    if (isLoading) return

    scheduleMap = new Map()

    isLoading = true
    try {
      // Check if selected date is a holiday
      const foundHoliday = cachedHolidays.find((h) => h.date?.split(' ')[0] === selectedDate)
      todayHoliday = foundHoliday || null

      // Fetch dailySchedule records for the selected day
      let schedules = await pb.collection('dailySchedule').getFullList({
        batch: 2000,
        filter: `date >= "${selectedDate} 00:00:00" && date <= "${selectedDate} 23:59:59"`,
        expand: 'student,subject,room,customSchedule',
        fields: [
          'id,date,status,teacher,timeslot,student,subject,room,customSchedule',
          'expand.student.id,expand.student.englishName',
          'expand.subject.name',
          'expand.room.name',
          'expand.customSchedule.name,expand.customSchedule.color',
        ].join(','),
      })

      // On a holiday, only show records whose date exactly matches
      // (dailySchedule has a single date field so this is already guaranteed
      //  by the filter above, but keep for parity with the holiday intent)
      if (todayHoliday) {
        schedules = schedules.filter((s) => s.date?.split(' ')[0] === selectedDate)
      }

      // Build schedule map: teacherId-timeslotId -> array of schedule entries
      const bookedTeacherIds = new Set()

      for (const s of schedules) {
        const teacherId = s.teacher
        const timeslotId = s.timeslot
        if (!teacherId || !timeslotId) continue

        bookedTeacherIds.add(teacherId)
        const key = `${teacherId}-${timeslotId}`

        if (!scheduleMap.has(key)) scheduleMap.set(key, [])
        scheduleMap.get(key).push({
          subject: s.expand?.subject,
          students: s.expand?.student ? [{ id: s.expand.student.id, name: s.expand.student.englishName }] : [],
          roomName: s.expand?.room?.name || null,
          customSchedule: s.expand?.customSchedule || [],
        })
      }

      // Filter and sort teachers with the original logic:
      // 1. Teachers with rooms (A001, A002, etc.) come first, sorted by room number
      // 2. Teachers without rooms come after, sorted alphabetically by name
      // 3. Include disabled teachers only if they have bookings
      const teachers = cachedTeachers
        .filter((t) => t.status !== 'disabled' || bookedTeacherIds.has(t.id))
        .sort((a, b) => {
          const aRoom = teacherRoomMap.get(a.id)
          const bRoom = teacherRoomMap.get(b.id)

          // Unassigned teachers come last, sorted alphabetically among themselves
          if (!aRoom && !bRoom) return a.name.localeCompare(b.name)
          if (!aRoom) return 1
          if (!bRoom) return -1

          const aKey = getRoomSortKey(aRoom)
          const bKey = getRoomSortKey(bRoom)

          if (aKey.tier !== bKey.tier) return aKey.tier - bKey.tier
          return aKey.num - bKey.num
        })

      // Build grid data: rows = teachers, columns = teacher name, room, then timeslots
      const data = teachers.map((teacher, i) => {
        const bgClass = i % 2 === 0 ? 'bg-white text-neutral-800' : 'bg-neutral-100 text-neutral-800'

        const row = [
          { value: teacher.name, id: teacher.id, status: teacher.status, bgClass },
          { value: teacherRoomMap.get(teacher.id) || '—', bgClass },
        ]

        for (const ts of cachedTimeslots) {
          const schedules = scheduleMap.get(`${teacher.id}-${ts.id}`) || []
          row.push({
            label: schedules.length ? 'Schedule' : 'Empty',
            schedules,
            teacher,
            timeslot: ts,
            bgClass,
          })
        }
        return row
      })

      const columns = [
        {
          name: 'Teacher',
          width: '150px',
          formatter: (cell, row) => {
            const hasNewBadge = cell.status === 'new'

            let mtmCount = 0
            let grpCount = 0
            for (const ts of cachedTimeslots) {
              const entries = scheduleMap.get(`${cell.id}-${ts.id}`) || []
              if (!entries.length) continue

              const BREAK_SCHEDULES = ['lunch break', 'break time', 'other task']
              const isBreak = (entries[0]?.customSchedule || []).some((cs) =>
                BREAK_SCHEDULES.includes(cs?.name?.toLowerCase().trim())
              )
              if (isBreak) continue

              const roomName = (entries[0].roomName || '').toUpperCase()
              if (roomName.startsWith('A') || roomName.startsWith('ST') || roomName.startsWith('B')) mtmCount++
              else if (roomName.startsWith('G') || roomName.startsWith('H')) grpCount++
            }

            return h(
              'div',
              {
                class: `w-full h-full p-2 flex flex-col items-center justify-center text-center ${row.cells[0].data.bgClass}`,
              },
              [
                h(
                  'div',
                  { class: 'flex items-center gap-1' },
                  [
                    h('span', { class: 'font-bold text-neutral-700' }, cell.value),
                    hasNewBadge && h('span', { class: 'badge badge-success badge-xs ml-1' }, 'New'),
                  ].filter(Boolean)
                ),
                h(
                  'div',
                  { class: 'flex gap-1 mt-1' },
                  [
                    h('span', { class: 'text-xs' }, `MTM: ${mtmCount}`),
                    h('span', { class: 'text-xs' }, `GRP: ${grpCount}`),
                  ].filter(Boolean)
                ),
              ]
            )
          },
        },
        {
          name: 'Room',
          width: '120px',
          formatter: (cell, row) =>
            h(
              'div',
              {
                class: `w-full h-full p-2 flex items-center justify-center font-semibold text-center ${row.cells[1].data.bgClass}`,
              },
              cell.value
            ),
        },
        ...cachedTimeslots.map((ts) => ({
          id: ts.id,
          width: '200px',
          name: h('div', { class: 'flex flex-col items-center gap-0.5' }, [h('span', null, `${ts.start} - ${ts.end}`)]),
          formatter: formatCell,
        })),
      ]

      await tick()

      if (gridInstance) {
        if (savedScrollTop === null) {
          const wrapper = document.querySelector('#teacher-grid .gridjs-wrapper')
          savedScrollTop = wrapper?.scrollTop || 0
          savedScrollLeft = wrapper?.scrollLeft || 0
        }

        gridInstance.updateConfig({ columns, data }).forceRender()

        requestAnimationFrame(() => {
          const wrapper = document.querySelector('#teacher-grid .gridjs-wrapper')
          if (wrapper) {
            wrapper.scrollTop = savedScrollTop
            wrapper.scrollLeft = savedScrollLeft || 0
          }
        })
      } else {
        gridInstance = new Grid({
          columns,
          data,
          search: {
            selector: (cell) => {
              if (!cell || typeof cell !== 'object') return String(cell ?? '')
              // Teacher / Room columns → use the `.value` property
              if ('value' in cell) return cell.value ?? ''
              // Separator rows → skip
              if (cell.isSeparator) return ''
              // Schedule cells → build a searchable string from all relevant fields
              if (!cell.schedules?.length) return ''

              const first = cell.schedules[0]
              const parts = [
                first.subject?.name ?? '',
                first.teacher?.name ?? '',
                ...cell.schedules.flatMap((s) => s.students.map((std) => std.name)),
              ]
              return parts.join(' ')
            },
          },
          height: 'calc(100vh - 220px)',
          className: {
            table: 'table w-full',
            th: 'text-center',
            td: 'text-center',
            search: 'input input-sm m-5',
            pagination: 'flex flex-row justify-between mt-5',
            paginationButton: 'btn btn-sm',
          },
          style: { table: { 'table-layout': 'fixed' } },
        }).render(document.getElementById('teacher-grid'))
      }
    } catch (err) {
      console.error('Failed to load teacher schedule:', err)
      toast.error('Failed to load teacher schedule')
    } finally {
      isLoading = false
    }
  }

  async function refreshWithScroll() {
    const wrapper = document.querySelector('#teacher-grid .gridjs-wrapper')
    const savedScrollTop = wrapper?.scrollTop || 0
    const savedScrollLeft = wrapper?.scrollLeft || 0
    await loadTeacherSchedule(savedScrollTop, savedScrollLeft)
  }

  async function setupSubscriptions() {
    unsubSchedule = await pb.collection('dailySchedule').subscribe('*', (e) => {
      const recDate = e.record?.date?.split(' ')[0]
      if (!recDate || recDate !== selectedDate) return
      refreshWithScroll()
    })

    unsubRoomType = await pb.collection('roomType').subscribe('*', async () => {
      await loadStaticData()
      refreshWithScroll()
    })

    unsubTeacher = await pb.collection('teacher').subscribe('*', async () => {
      await loadStaticData()
      refreshWithScroll()
    })
  }

  onMount(async () => {
    await loadStaticData()
    await loadTeacherSchedule()
    await setupSubscriptions()
  })

  onDestroy(() => {
    unsubSchedule?.()
    unsubRoomType?.()
    unsubTeacher?.()

    if (gridInstance) {
      gridInstance.destroy()
      gridInstance = null
    }
  })
</script>

<div class="p-2 sm:p-4 md:p-6 bg-base-100">
  <div class="flex items-center justify-between mb-4 text-2xl font-bold">
    <h2 class="text-center flex-1">Teacher Daily View</h2>
    <div class="w-6 h-6 flex items-center justify-center">
      {#if isLoading}
        <div class="loading loading-spinner loading-sm"></div>
      {/if}
    </div>
  </div>

  <div class="mb-2 grid grid-cols-3 items-center">
    <!-- Left: holiday badge -->
    <div class="flex items-center">
      {#if todayHoliday}
        <span
          class="flex items-center gap-2 text-yellow-700 border border-yellow-300 bg-yellow-50 rounded-lg px-3 py-1"
        >
          <span class="text-lg">🎉</span>
          <span class="text-sm font-semibold">{todayHoliday.name}</span>
        </span>
      {/if}
    </div>

    <!-- Center: date -->
    <h3 class="text-xl font-semibold text-center">
      {formatDateDisplay(selectedDate)}
    </h3>

    <!-- Right: nav buttons -->
    <div class="flex items-center gap-2 justify-end">
      <button
        class="btn btn-outline btn-sm"
        onclick={goToToday}
        disabled={isLoading || selectedDate === getTodayDate()}
      >
        Today
      </button>
      <button class="btn btn-outline btn-sm" onclick={() => changeDay(-1)} disabled={isLoading}>&larr;</button>
      <input
        type="date"
        class="input input-bordered input-sm w-auto"
        value={selectedDate}
        onchange={onDateChange}
        disabled={isLoading}
      />
      <button class="btn btn-outline btn-sm" onclick={() => changeDay(1)} disabled={isLoading}>&rarr;</button>
    </div>
  </div>

  <div id="teacher-grid" class="rounded-lg"></div>
</div>

<style>
  :global(html) {
    scrollbar-gutter: stable;
  }

  #teacher-grid :global(.gridjs-wrapper) {
    max-height: calc(100vh - 220px);
    overflow: auto;
    contain: layout;
    will-change: scroll-position;
  }

  /* Zero out padding on td to let background divs fill full width/height completely */
  #teacher-grid :global(td) {
    padding: 0 !important;
    vertical-align: stretch;
    position: relative;
  }

  #teacher-grid :global(th) {
    position: sticky;
    top: 0;
    z-index: 20;
    background-color: #535252;
    color: #ffffff;
  }

  /* Sticky first column (Teacher) */
  #teacher-grid :global(th:nth-child(1)),
  #teacher-grid :global(td:nth-child(1)) {
    position: sticky;
    left: 0;
    z-index: 15;
  }

  #teacher-grid :global(th:nth-child(1)) {
    z-index: 25;
  }

  /* Sticky second column (Room) */
  #teacher-grid :global(th:nth-child(2)),
  #teacher-grid :global(td:nth-child(2)) {
    position: sticky;
    left: 150px;
    z-index: 10;
  }

  #teacher-grid :global(th:nth-child(2)) {
    z-index: 25;
  }

  /* font bold for teacher and room td */
  #teacher-grid :global(td:nth-child(1) div),
  #teacher-grid :global(td:nth-child(2) div) {
    font-size: 0.85rem;
    font-weight: bold;
  }

  /* stronger table border */
  #teacher-grid :global(.gridjs-table td),
  #teacher-grid :global(.gridjs-table th) {
    outline: 1px solid #535252;
  }
</style>
