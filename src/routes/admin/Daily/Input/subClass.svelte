<script>
  import { onMount, tick } from 'svelte'
  import { Grid, h } from 'gridjs'
  import 'gridjs/dist/theme/mermaid.css'
  import { toast } from 'svelte-sonner'
  import SubModal from './subModal.svelte'
  import { pb } from '../../../../lib/Pocketbase.svelte'
  import MakeupModal from './makeupModal.svelte'

  // ─────────────────────────────────────────────
  // SECTION 1: Non-reactive module-level state
  // ─────────────────────────────────────────────
  let gridInstance = null
  let refreshTimer = null
  let cachedTimeslots = []
  let cachedTeachers = []
  let cachedRooms = []
  let cachedHolidays = []
  let teacherRoomMap = new Map()
  let teacherRoomObjMap = new Map()

  // ─────────────────────────────────────────────
  // SECTION 2: Reactive state
  // ─────────────────────────────────────────────
  let subModal = $state()
  let makeupModal = $state()
  let selectedDate = $state(getTodayDate())
  let todayHoliday = $state(null)
  let isLoading = $state(false)
  let subCount = $state(0) // unique teacher-timeslot cells that have a sub assigned

  // ─────────────────────────────────────────────
  // SECTION 3: Pure helper functions
  // ─────────────────────────────────────────────

  const BREAK_SCHEDULES = ['lunch break', 'break time', 'other task']

  function getTodayDate() {
    return new Date().toISOString().split('T')[0]
  }

  function formatDateDisplay(dateStr) {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }

  function offsetDate(dateStr, days) {
    const d = new Date(dateStr)
    d.setDate(d.getDate() + days)
    return d.toISOString().split('T')[0]
  }

  // Sort key restricted to MTM room prefixes (A / ST main building, B annex 2)
  function getRoomSortKey(roomName) {
    if (!roomName) return { tier: 99, num: Infinity }
    const upper = roomName.toUpperCase()

    let tier
    if (upper.startsWith('ST')) tier = 1
    else if (upper.startsWith('A')) tier = 0
    else if (upper.startsWith('B')) tier = 2
    else tier = 3

    const num = parseInt(upper.replace(/\D/g, ''), 10)
    return { tier, num: isNaN(num) ? Infinity : num }
  }

  function saveScroll() {
    const wrapper = document.querySelector('#sub-grid .gridjs-wrapper')
    return { top: wrapper?.scrollTop || 0, left: wrapper?.scrollLeft || 0 }
  }

  function restoreScroll(scroll) {
    if (!scroll) return
    requestAnimationFrame(() => {
      const wrapper = document.querySelector('#sub-grid .gridjs-wrapper')
      if (wrapper) {
        wrapper.scrollTop = scroll.top
        wrapper.scrollLeft = scroll.left
      }
    })
  }

  // ─────────────────────────────────────────────
  // SECTION 4: Grid cell formatters
  // ─────────────────────────────────────────────

  function formatTeacherCell(cell, row) {
    const bgClass = row.cells[0].data.bgClass
    const hasNewBadge = cell.status === 'new'
    const subGivenCount = cell.subGivenCount || 0

    return h(
      'div',
      { class: `w-full h-full p-2 flex flex-col items-center justify-center text-center ${bgClass}` },
      [
        h(
          'div',
          { class: 'flex items-center gap-1' },
          [
            h('span', { class: 'font-bold text-neutral-700' }, cell.value),
            hasNewBadge && h('span', { class: 'badge badge-success badge-xs ml-1' }, 'New'),
          ].filter(Boolean)
        ),
        subGivenCount > 0 &&
          h('div', { class: 'flex gap-1 mt-1' }, [
            h('span', { class: 'text-sm font-bold text-info' }, `Subs: ${subGivenCount}`),
          ]),
      ].filter(Boolean)
    )
  }

  function formatRoomCell(cell, row) {
    const bgClass = row.cells[1].data.bgClass
    return h(
      'div',
      { class: `w-full h-full p-2 flex items-center justify-center font-semibold text-center ${bgClass}` },
      cell.value
    )
  }

  function formatSubCell(cell) {
    const bgClass = cell?.bgClass || 'bg-white'

    if (!cell?.schedules?.length) {
      return h(
        'div',
        {
          class: `group w-full h-full min-h-[55px] flex items-center justify-center text-gray-400 sub-cell-empty cursor-pointer transition-colors hover:bg-info/10 ${bgClass}`,
          title: 'Click to create a make-up class',
          onClick: () => handleEmptyCellClick(cell),
        },
        h('span', { class: 'group-hover:hidden' }, '—'),
        h('span', { class: 'hidden group-hover:inline text-info font-bold text-lg' }, '+')
      )
    }

    const { schedules } = cell
    const first = schedules[0]

    const customSchedules = first?.customSchedule || []
    const breakSchedule = customSchedules.find((cs) => BREAK_SCHEDULES.includes(cs.name?.toLowerCase().trim()))

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

    const subjectName = first.subject?.name || 'No Subject'
    const roomName = first.roomName || 'No Room'
    const allStudents = schedules.flatMap((s) => s.students.map((std) => std.name))
    const hasSub = !!first.sub
    const isGrp = /^[GH]/i.test(roomName)
    return h(
      'div',
      {
        class: `flex flex-col gap-1 p-2 items-center justify-center text-center w-full h-full sub-cell-with-schedule ${bgClass}`,
      },
      [
        h('div', { class: 'font-bold border-b border-neutral-500 mb-1 pb-1 w-full' }, [
          h('div', {}, subjectName),
          h('div', { class: 'text-xs uppercase mt-1' }, roomName),
        ]),
        h(
          'div',
          { class: 'flex flex-wrap justify-center gap-1' },
          allStudents.map((name, i) =>
            h(
              'span',
              { class: 'text-xs font-semibold whitespace-nowrap' },
              isGrp && i < allStudents.length - 1 ? `${name},` : name
            )
          )
        ),
        hasSub
          ? h('div', { class: 'flex items-center justify-center gap-1 mt-1' }, [
              h('span', { class: 'text text-sm font-semibold' }, `Sub: ${first.sub.name}`),
            ])
          : h('span', { class: 'text text-xs opacity-40 mt-1' }, 'No sub assigned'),
      ]
    )
  }

  // ─────────────────────────────────────────────
  // SECTION 5: Data transformation
  // ─────────────────────────────────────────────

  /**
   * Includes id and sub — required by subModal for batch updates.
   * sub is expanded so first.sub is the teacher object, not just an ID.
   * room is the schedule's ACTUAL room (dynamic per schedule, not the
   * teacher's default assigned room) so subs/room-swaps stay accurate.
   */
  function normalizeSchedules(rawSchedules) {
    return rawSchedules.map((s) => ({
      id: s.id,
      teacherId: s.expand?.teacher?.id,
      timeslotId: s.expand?.timeslot?.id,
      room: s.expand?.room || null,
      roomName: s.expand?.room?.name || null,
      students: s.expand?.student ? [{ id: s.expand.student.id, name: s.expand.student.englishName }] : [],
      subject: s.expand?.subject,
      teacher: s.expand?.teacher,
      sub: s.expand?.sub || null,
      date: s.date?.split(' ')[0],
      status: s.status,
      customSchedule: s.expand?.customSchedule || [],
    }))
  }

  function buildScheduleMap(normalized) {
    const map = new Map()
    for (const s of normalized) {
      if (!s.teacherId || !s.timeslotId) continue
      const key = `${s.teacherId}-${s.timeslotId}`
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(s)
    }
    return map
  }

  // ─────────────────────────────────────────────
  // SECTION 6: Grid config builder
  // ─────────────────────────────────────────────

  function buildGridConfig(teachers, timeslots, scheduleMap, subCountMap) {
    const columns = [
      {
        name: 'Teacher',
        width: '150px',
        formatter: formatTeacherCell,
      },
      {
        name: 'Room',
        width: '120px',
        formatter: formatRoomCell,
      },
      ...timeslots.map((t) => ({
        id: t.id,
        width: '180px',
        name: h('div', { class: 'flex flex-col items-center gap-0.5' }, [h('span', null, `${t.start} - ${t.end}`)]),
        formatter: formatSubCell,
      })),
    ]

    const data = teachers.map((teacher, i) => {
      const bgClass = i % 2 === 0 ? 'bg-white text-neutral-800' : 'bg-neutral-100 text-neutral-800'

      const row = [
        {
          value: teacher.name,
          status: teacher.status,
          bgClass,
          subGivenCount: subCountMap.get(teacher.id) || 0,
        },
        { value: teacherRoomMap.get(teacher.id) || '—', bgClass },
      ]

      for (const ts of timeslots) {
        const schedules = scheduleMap.get(`${teacher.id}-${ts.id}`) || []
        row.push({ schedules, teacher, timeslot: ts, room: teacherRoomObjMap.get(teacher.id) || null, bgClass })
      }

      return row
    })

    return { columns, data }
  }

  // ─────────────────────────────────────────────
  // SECTION 7: Grid renderer
  // ─────────────────────────────────────────────
  // NOTE: cells with a schedule stay display-only — assigning a sub still
  // happens exclusively through the "Assign Sub" button in the header.
  // Empty cells ARE clickable: formatSubCell attaches an onClick that
  // opens MakeupModal (see handleEmptyCellClick, SECTION 10).

  async function renderGrid(columns, data, scroll) {
    await tick()

    if (gridInstance) {
      gridInstance.updateConfig({ columns, data }).forceRender()
      restoreScroll(scroll)
    } else {
      gridInstance = new Grid({
        columns,
        data,
        search: {
          selector: (cell) => {
            if (!cell || typeof cell !== 'object') return String(cell ?? '')
            if ('value' in cell) return cell.value ?? ''
            if (!cell.schedules?.length) return ''
            const first = cell.schedules[0]
            return [
              first.subject?.name ?? '',
              first.teacher?.name ?? '',
              first.sub?.name ?? '',
              ...cell.schedules.flatMap((s) => s.students.map((std) => std.name)),
            ].join(' ')
          },
        },
        height: 'calc(100vh - 220px)',
        className: {
          table: 'w-full border text-xs !border-collapse',
          th: 'text-center',
          td: 'text-center',
        },
        style: { table: { 'table-layout': 'fixed' } },
      }).render(document.getElementById('sub-grid'))
    }
  }

  // ─────────────────────────────────────────────
  // SECTION 8: Data fetching
  // ─────────────────────────────────────────────

  async function fetchCoreData(date) {
    const [timeslots, teachers, rooms, schedules] = await Promise.all([
      cachedTimeslots.length
        ? Promise.resolve(cachedTimeslots)
        : pb.collection('timeslot').getFullList({ sort: 'start' }),
      cachedTeachers.length
        ? Promise.resolve(cachedTeachers)
        : pb.collection('teacher').getFullList({ sort: 'name', fields: 'id,name,status' }),
      cachedRooms.length
        ? Promise.resolve(cachedRooms)
        : pb.collection('roomType').getFullList({
            sort: 'name',
            expand: 'teacher',
            filter: 'roomType = "mtm"',
          }),
      pb.collection('dailySchedule').getFullList({
        filter: `date >= "${date} 00:00:00" && date <= "${date} 23:59:59"`,
        // sub is expanded so first.sub = teacher object, not just an ID
        expand: 'teacher,student,subject,room,timeslot,customSchedule,sub',
      }),
    ])

    if (!cachedTimeslots.length) cachedTimeslots = timeslots
    if (!cachedTeachers.length) cachedTeachers = teachers
    if (!cachedRooms.length) {
      cachedRooms = rooms
      const roomsWithTeacher = rooms.filter((rt) => rt.expand?.teacher)
      teacherRoomMap = new Map(roomsWithTeacher.map((rt) => [rt.expand.teacher.id, rt.name]))
      teacherRoomObjMap = new Map(roomsWithTeacher.map((rt) => [rt.expand.teacher.id, rt]))
    }

    return { timeslots, teachers, rooms, schedules }
  }

  // ─────────────────────────────────────────────
  // SECTION 9: Main load orchestrator
  // ─────────────────────────────────────────────

  async function loadSchedules(scroll = null) {
    if (isLoading) {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => loadSchedules(scroll), 300)
      return
    }

    isLoading = true
    try {
      const { timeslots, schedules } = await fetchCoreData(selectedDate)
      todayHoliday = cachedHolidays.find((h) => h.date?.split(' ')[0] === selectedDate) || null

      const normalized = normalizeSchedules(schedules)

      // Count unique teacher-timeslot cells that have a sub assigned,
      // and track which teachers actually have a schedule today —
      // even if they have no default MTM room assigned.
      const subSet = new Set()
      const subCountMap = new Map() // subTeacherId -> count of sub assignments today
      const bookedTeacherIds = new Set()
      for (const s of normalized) {
        if (s.sub) {
          subSet.add(`${s.teacherId}-${s.timeslotId}`)
          subCountMap.set(s.sub.id, (subCountMap.get(s.sub.id) || 0) + 1)
        }
        if (s.teacherId) bookedTeacherIds.add(s.teacherId)
      }
      subCount = subSet.size

      const scheduleMap = buildScheduleMap(normalized)

      // Show teachers who either have an MTM room assigned OR have a
      // schedule today (covers teachers filling in outside their usual
      // room/status). Room-assigned teachers sort first by room; the rest
      // sort alphabetically after.
      const teachers = cachedTeachers
        .filter((t) => t.status !== 'disabled' || bookedTeacherIds.has(t.id))
        .sort((a, b) => {
          const aRoom = teacherRoomMap.get(a.id)
          const bRoom = teacherRoomMap.get(b.id)

          if (!aRoom && !bRoom) return a.name.localeCompare(b.name)
          if (!aRoom) return 1
          if (!bRoom) return -1

          const aKey = getRoomSortKey(aRoom)
          const bKey = getRoomSortKey(bRoom)
          if (aKey.tier !== bKey.tier) return aKey.tier - bKey.tier
          return aKey.num - bKey.num
        })

      const { columns, data } = buildGridConfig(teachers, timeslots, scheduleMap, subCountMap)
      await renderGrid(columns, data, scroll)
    } catch (err) {
      console.error(err)
      toast.error('Failed to load sub schedules')
    } finally {
      isLoading = false
    }
  }

  // ─────────────────────────────────────────────
  // SECTION 10: User action handlers
  // ─────────────────────────────────────────────

  async function changeDay(days) {
    const scroll = saveScroll()
    selectedDate = offsetDate(selectedDate, days)
    await loadSchedules(scroll)
  }

  async function onDateChange(e) {
    const scroll = saveScroll()
    selectedDate = e.target.value
    await loadSchedules(scroll)
  }

  async function goToToday() {
    const scroll = saveScroll()
    selectedDate = getTodayDate()
    await loadSchedules(scroll)
  }

  async function refreshWithScroll() {
    await loadSchedules(saveScroll())
  }

  function openSubModal() {
    subModal.open({
      date: selectedDate,
      teachers: cachedTeachers,
      timeslots: cachedTimeslots,
    })
  }

  // Empty cell = no schedule for that teacher/timeslot today — open
  // MakeupModal pre-filled with teacher/timeslot/date/room so a new
  // make-up class can be created directly from the grid.
  function handleEmptyCellClick(cell) {
    if (!cell?.teacher || !cell?.timeslot) return
    makeupModal.open({
      teacher: cell.teacher,
      room: cell.room || null, // null if teacher has no assigned MTM room — MakeupModal shows its own room picker in that case
      timeslot: cell.timeslot,
      date: selectedDate,
      schedules: [], // empty → MakeupModal opens in create mode, not edit mode
    })
  }

  // ─────────────────────────────────────────────
  // SECTION 11: Lifecycle
  // ─────────────────────────────────────────────

  onMount(async () => {
    cachedHolidays = await pb
      .collection('holiday')
      .getFullList({ fields: 'id,name,date' })
      .catch(() => [])

    await loadSchedules()

    return () => {
      gridInstance?.destroy()
      gridInstance = null
      clearTimeout(refreshTimer)
    }
  })
</script>

<!-- ─────────────────────────────────────────── -->
<!-- TEMPLATE                                    -->
<!-- ─────────────────────────────────────────── -->

<div class="p-2 sm:p-4 md:p-6 bg-base-100">
  <!-- Header -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-4 gap-2">
    <div class="order-2 sm:order-1 flex-1 flex items-center justify-center sm:justify-start">
      <button class="btn btn-info btn-sm" onclick={openSubModal}>+ Assign Sub</button>
    </div>

    <h2 class="order-1 sm:order-2 text-center flex-1 text-xl sm:text-2xl font-bold">Daily Make-up/SubClass Schedule</h2>

    <div class="order-3 flex-1 flex items-center gap-3 justify-center sm:justify-end">
      {#if subCount > 0}
        <span class="badge badge-info badge-lg gap-2 font-bold text-sm">
          {subCount} sub{subCount === 1 ? '' : 's'} assigned
        </span>
      {:else}
        <span class="text-sm font-normal opacity-40">No subs assigned</span>
      {/if}
      <div class="w-6 h-6 flex items-center justify-center">
        {#if isLoading}
          <div class="loading loading-spinner loading-sm"></div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Date bar -->
  <div class="mb-2 flex flex-col gap-2 sm:grid sm:grid-cols-3 sm:items-center">
    <!-- Holiday badge -->
    <div class="order-3 sm:order-1 flex items-center justify-center sm:justify-start">
      {#if todayHoliday}
        <span
          class="flex items-center gap-2 text-yellow-700 border border-yellow-300 bg-yellow-50 rounded-lg px-3 py-1"
        >
          <span class="text-lg">🎉</span>
          <span class="text-sm font-semibold">{todayHoliday.name}</span>
        </span>
      {/if}
    </div>

    <!-- Formatted date -->
    <h3 class="order-1 sm:order-2 text-lg sm:text-xl font-semibold text-center">
      {formatDateDisplay(selectedDate)}
    </h3>

    <!-- Navigation controls -->
    <div class="order-2 sm:order-3 flex items-center gap-1 sm:gap-2 justify-center sm:justify-end flex-wrap">
      <button
        class="btn btn-outline btn-sm"
        onclick={goToToday}
        disabled={isLoading || selectedDate === getTodayDate()}
      >
        Today
      </button>
      <button class="btn btn-outline btn-sm btn-square" onclick={() => changeDay(-1)} disabled={isLoading}
        >&larr;</button
      >
      <input
        type="date"
        class="input input-bordered input-sm w-[150px] sm:w-auto"
        value={selectedDate}
        onchange={onDateChange}
        disabled={isLoading}
      />
      <button class="btn btn-outline btn-sm btn-square" onclick={() => changeDay(1)} disabled={isLoading}>&rarr;</button
      >
    </div>
  </div>

  <!-- Grid container — gridjs renders into this div (display-only, no click interactivity) -->
  <div class="overflow-x-auto rounded-lg">
    <div id="sub-grid"></div>
  </div>
</div>

<SubModal bind:this={subModal} onrefresh={refreshWithScroll} />
<MakeupModal bind:this={makeupModal} onrefresh={refreshWithScroll} />

<!-- ─────────────────────────────────────────── -->
<!-- STYLES                                      -->
<!-- ─────────────────────────────────────────── -->

<style>
  :global(html) {
    scrollbar-gutter: stable;
  }

  /* Scrollable grid wrapper */
  #sub-grid :global(.gridjs-wrapper) {
    max-height: calc(100vh - 220px);
    overflow: auto;
    contain: layout;
    will-change: scroll-position;
  }

  /* Zero out padding on td so background divs fill the full cell */
  #sub-grid :global(td) {
    padding: 0 !important;
    vertical-align: stretch;
  }

  /* Sticky header row */
  #sub-grid :global(th) {
    position: sticky;
    top: 0;
    z-index: 20;
    background-color: #535252;
    color: #ffffff;
  }

  /* Sticky "Teacher" column */
  #sub-grid :global(th:nth-child(1)),
  #sub-grid :global(td:nth-child(1)) {
    position: sticky;
    left: 0;
    z-index: 15;
  }

  #sub-grid :global(th:nth-child(1)) {
    z-index: 25;
  }

  /* Sticky "Room" column */
  #sub-grid :global(th:nth-child(2)),
  #sub-grid :global(td:nth-child(2)) {
    position: sticky;
    left: 150px;
    z-index: 10;
  }

  #sub-grid :global(th:nth-child(2)) {
    z-index: 25;
  }

  /* Bold font for teacher and room sticky cols */
  #sub-grid :global(td:nth-child(1) div),
  #sub-grid :global(td:nth-child(2) div) {
    font-size: 0.85rem;
    font-weight: bold;
  }

  /* Stronger table borders */
  #sub-grid :global(.gridjs-table td),
  #sub-grid :global(.gridjs-table th) {
    outline: 1px solid #535252;
  }
</style>
