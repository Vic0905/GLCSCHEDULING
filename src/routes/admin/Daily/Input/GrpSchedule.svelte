<script>
  import { onMount, tick } from 'svelte'
  import { Grid, h } from 'gridjs'
  import { toast } from 'svelte-sonner'
  //   import { pb } from '../../../lib/Pocketbase.svelte'
  import CombineModal from './combineModal.svelte'
  import { pb } from '../../../../lib/Pocketbase.svelte'
  import CopyModal from './copyModal.svelte'
  import ShowStatusModal from './showStatusModal.svelte'
  import ClearDayModal from './clearDayModal.svelte'
  import ImportModal from './importModal.svelte'

  // ─────────────────────────────────────────────
  // SECTION 1: Non-reactive module-level state
  // ─────────────────────────────────────────────
  let gridInstance = null
  let refreshTimer = null

  let cachedTimeslots = []
  let cachedRooms = []
  let cachedHolidays = []

  // ─────────────────────────────────────────────
  // SECTION 2: Reactive state
  // ─────────────────────────────────────────────
  let combineModal = $state()
  let showStatusModal = $state()
  let clearDayModal = $state()
  let copyModal = $state()
  let importModal = $state()
  let selectedDate = $state(getInitialDate())
  let todayHoliday = $state(null)
  let isLoading = $state(false)
  let scheduleStatusSummary = $state({ total: 0, showCount: 0, draftCount: 0 })

  // ─────────────────────────────────────────────
  // SECTION 3: Pure helper functions
  // ─────────────────────────────────────────────

  // CHANGED: hoisted from inside formatScheduleCell to module scope so it can
  // also be reused in the cellClick handler.
  const BREAK_SCHEDULES = ['lunch break', 'break time', 'other task']

  function getInitialDate() {
    const hash = window.location.hash
    const queryString = hash.includes('?') ? hash.split('?')[1] : ''
    const params = new URLSearchParams(queryString)
    return params.get('date') || getTodayDate()
  }

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

  /**
   * Per-building styling config: prefix, alternating band ranges,
   * and Tailwind classes for banded vs base rooms.
   */
  const BUILDING_CONFIG = {
    main: {
      prefix: 'G',
      bandColor: 'bg-neutral-300 text-neutral-800',
      baseColor: 'bg-white text-neutral-800',
      bands: [[12, 18]],
    },
    annex2: {
      prefix: 'H',
      bandColor: 'bg-white text-neutral-800',
      baseColor: 'bg-neutral-200/90 text-neutral-800',
      bands: [
        [1, 10],
        [30, 50],
      ],
    },
  }

  /**
   * Returns a Tailwind bg+text class pair based on room name and BUILDING_CONFIG.
   */
  function getBgClass(roomName) {
    if (!roomName) return ''
    const upper = roomName.toUpperCase()

    for (const config of Object.values(BUILDING_CONFIG)) {
      if (!upper.startsWith(config.prefix)) continue

      const num = parseInt(upper.replace(/\D/g, ''), 10)
      if (isNaN(num)) return config.baseColor

      const inBand = config.bands.some(([min, max]) => num >= min && num <= max)
      return inBand ? config.bandColor : config.baseColor
    }

    return ''
  }

  /**
   * Returns the building section for a room name:
   * 'main' for G-prefixed rooms (Main Building),
   * 'annex2' for H-prefixed rooms (Annex 2), null otherwise.
   */
  function getBuildingSection(roomName) {
    if (!roomName) return null
    const upper = roomName.toUpperCase()
    if (upper.startsWith('G')) return 'main'
    if (upper.startsWith('H')) return 'annex2'
    return null
  }

  function saveScroll() {
    const wrapper = document.querySelector('#daily-grid .gridjs-wrapper')
    return {
      top: wrapper?.scrollTop || 0,
      left: wrapper?.scrollLeft || 0,
    }
  }

  function restoreScroll(scroll) {
    if (!scroll) return
    requestAnimationFrame(() => {
      const wrapper = document.querySelector('#daily-grid .gridjs-wrapper')
      if (wrapper) {
        wrapper.scrollTop = scroll.top
        wrapper.scrollLeft = scroll.left
      }
    })
  }

  // ─────────────────────────────────────────────
  // SECTION 4: Grid cell formatters
  // ─────────────────────────────────────────────

  function formatTeacherCell(value, bgClass, isSeparator, isSectionTitle = false) {
    if (isSeparator) {
      if (isSectionTitle) {
        return h(
          'div',
          {
            class: `w-full h-full px-4 py-3 flex items-center font-bold text-lg tracking-wide ${bgClass}`,
          },
          value
        )
      }

      return h('div', {
        class: `w-full h-full ${bgClass}`,
      })
    }

    return h(
      'div',
      {
        class: `w-full h-full p-2 flex items-center justify-center text-center ${bgClass}`,
      },
      value
    )
  }

  function formatRoomCell(value, bgClass, isSeparator) {
    if (isSeparator) {
      return h('div', { class: `w-full h-full p-1 ${bgClass}` })
    }
    return h(
      'div',
      { class: `w-full h-full p-2 flex items-center justify-center font-semibold text-center ${bgClass}` },
      value
    )
  }

  function formatScheduleCell(cell) {
    const bgClass = cell?.bgClass || ''

    if (cell?.isSeparator) {
      return h('div', {
        class: `w-full h-full ${bgClass}`,
      })
    }

    if (!cell?.schedules?.length) {
      return h(
        'div',
        { class: `w-full h-full min-h-[55px] flex items-center justify-center text-gray-400 ${bgClass}` },
        '—'
      )
    }

    const { schedules } = cell
    const first = schedules[0]

    // CHANGED: customSchedule is now a multi-relation array, so we search it
    // for a break-type tag instead of assuming `first.customSchedule` is a
    // single object.
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
    const teacherName = first.teacher?.name || 'No Teacher'
    const allStudents = schedules.flatMap((s) => s.students.map((std) => std.name))
    const status = first.status
    const statusClass = status === 'show' ? 'badge-success' : 'badge-warning'

    return h('div', { class: `flex flex-col gap-1 p-2 items-center text-center w-full h-full ${bgClass}` }, [
      h('div', { class: 'font-bold text-neutral-900 border-b border-neutral-500 mb-1 pb-1 w-full' }, [
        h('div', {}, subjectName),
        h('div', { class: 'text-[10px] uppercase mt-1' }, teacherName),
      ]),
      h(
        'div',
        { class: 'flex flex-wrap justify-center gap-1 flex-1' },
        allStudents.map((name) =>
          h('span', { class: 'badge badge-ghost font-semibold badge-xs whitespace-nowrap' }, name)
        )
      ),
      h('div', { class: 'flex justify-start w-full mt-1 gap-1 flex-wrap' }, [
        h('span', { class: `badge badge-xs ${statusClass}` }, status),
        // CHANGED: render a badge for every remaining tag (e.g. "Sub Class"
        // alongside others), instead of only the single first.customSchedule.
        ...customSchedules.map((cs) =>
          h(
            'span',
            {
              class: 'text-xs font-bold',
              style: cs.color ? `background:${cs.color}20; color:${cs.color}; border-color:${cs.color}80;` : '',
            },
            cs.name || 'Custom'
          )
        ),
      ]),
    ])
  }

  // ─────────────────────────────────────────────
  // SECTION 5: Data transformation
  // ─────────────────────────────────────────────

  function normalizeSchedules(rawSchedules, date, holiday) {
    return rawSchedules
      .filter((s) => {
        // On a holiday, only show schedules whose date exactly matches
        // (same behaviour as before, but now we check the single `date` field)
        if (!holiday) return true
        return s.date?.split(' ')[0] === date
      })
      .map((s) => ({
        roomId: s.expand?.room?.id,
        timeslotId: s.expand?.timeslot?.id,
        students: s.expand?.student ? [{ id: s.expand.student.id, name: s.expand.student.englishName }] : [],
        subject: s.expand?.subject,
        teacher: s.expand?.teacher,
        date: s.date?.split(' ')[0],
        status: s.status,
        // CHANGED: keep the full array instead of unwrapping to `[0]`, so
        // records with multiple tags (e.g. "Sub Class" + a break tag) don't
        // silently lose data here.
        customSchedule: s.expand?.customSchedule || [],
      }))
  }

  function buildScheduleMap(normalizedSchedules) {
    const map = new Map()
    for (const s of normalizedSchedules) {
      if (!s.roomId || !s.timeslotId) continue
      const key = `${s.roomId}-${s.timeslotId}`
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(s)
    }
    return map
  }

  /**
   * Counts empty rooms per timeslot, split by building section.
   * Returns Map<timeslotId, { main: number, annex2: number }>
   * - main: Main Building rooms (G-prefixed)
   * - annex2: Annex 2 rooms (H-prefixed)
   */
  function buildEmptyCountMapBySection(timeslots, rooms, scheduleMap) {
    const map = new Map()
    for (const ts of timeslots) {
      let main = 0
      let annex2 = 0
      for (const room of rooms) {
        const hasSchedule = (scheduleMap.get(`${room.id}-${ts.id}`) || []).length
        if (hasSchedule) continue

        const section = getBuildingSection(room.name)
        if (section === 'main') main++
        else if (section === 'annex2') annex2++
      }
      map.set(ts.id, { main, annex2 })
    }
    return map
  }

  // ─────────────────────────────────────────────
  // SECTION 6: Grid config builder
  // ─────────────────────────────────────────────

  function buildGridConfig(rooms, timeslots, scheduleMap, emptyCountMap) {
    const columns = [
      {
        name: 'Teacher',
        width: '120px',
        formatter: (c, row) =>
          formatTeacherCell(
            c.value,
            row.cells[0].data.bgClass,
            row.cells[0].data.isSeparator,
            row.cells[0].data.isSectionTitle
          ),
      },
      {
        name: 'Room',
        width: '120px',
        formatter: (c, row) => formatRoomCell(c.value, row.cells[1].data.bgClass, row.cells[1].data.isSeparator),
      },
      ...timeslots.map((t) => {
        const counts = emptyCountMap.get(t.id) || { main: 0, annex2: 0 }
        return {
          id: t.id,
          width: '200px',
          name: h('div', { class: 'flex flex-col items-center gap-0.5' }, [
            h('span', null, `${t.start} - ${t.end}`),
            h('div', { class: 'flex gap-1' }, [
              h('span', { class: 'text-[10px] font-bold badge badge-success badge-xs' }, `Main: ${counts.main}`),
              h('span', { class: 'text-[10px] font-bold badge badge-info badge-xs' }, `Annex 2: ${counts.annex2}`),
            ]),
          ]),
          formatter: formatScheduleCell,
        }
      }),
    ]

    const data = []
    let annexInserted = false

    for (const room of rooms) {
      // Insert separator row before the first Annex 2 (H-prefixed) room
      if (!annexInserted && getBuildingSection(room.name) === 'annex2') {
        const separatorRow = [
          {
            value: 'ANNEX 2 BUILDING',
            disabled: true,
            bgClass: 'bg-neutral-700 text-white',
            isSeparator: true,
            isSectionTitle: true,
          },
          {
            value: '',
            disabled: true,
            bgClass: 'bg-neutral-700',
            isSeparator: true,
          },
          ...timeslots.map(() => ({
            isSeparator: true,
            bgClass: 'bg-neutral-700',
          })),
        ]
        data.push(separatorRow)
        annexInserted = true
      }

      const bgClass = getBgClass(room.name)
      const teacher = room.expand?.teacher

      const row = [
        { value: teacher?.name || '-', disabled: true, bgClass },
        { value: room.name, disabled: true, bgClass },
      ]

      for (const ts of timeslots) {
        const schedules = scheduleMap.get(`${room.id}-${ts.id}`) || []
        row.push({
          label: schedules.length ? 'Schedule' : 'Empty',
          schedules,
          room,
          timeslot: ts,
          bgClass,
        })
      }

      data.push(row)
    }

    return { columns, data }
  }

  // ─────────────────────────────────────────────
  // SECTION 7: Grid renderer
  // ─────────────────────────────────────────────

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
      }).render(document.getElementById('daily-grid'))

      gridInstance.on('cellClick', (_e, cell) => {
        const data = cell.data
        if (data.disabled || data.isSeparator) return

        const isCreate = data.label === 'Empty'
        const firstSched = data.schedules?.[0]

        combineModal.open({
          room: data.room,
          timeslot: data.timeslot,
          teacher: isCreate ? data.room?.expand?.teacher : firstSched?.teacher,
          date: isCreate ? selectedDate : firstSched?.date || selectedDate,
          mode: isCreate ? 'create' : 'edit',
          schedules: data.schedules,
          // CHANGED: combineModal's dropdown is single-select and only
          // manages the break-type tag, so pull just that one out of the
          // array instead of passing the whole array (or [0]) to it.
          customSchedule: isCreate
            ? null
            : (firstSched?.customSchedule || []).find((cs) =>
                BREAK_SCHEDULES.includes(cs.name?.toLowerCase().trim())
              ) || null,
        })
      })
    }
  }

  // ─────────────────────────────────────────────
  // SECTION 8: Data fetching
  // ─────────────────────────────────────────────

  async function fetchHolidays() {
    if (cachedHolidays.length) return
    cachedHolidays = await pb.collection('holiday').getFullList({ fields: 'id,name,date' })
  }

  async function fetchCoreData(date) {
    const dateStr = `${date} 23:59:59`

    const [timeslots, rooms, schedules] = await Promise.all([
      cachedTimeslots.length
        ? Promise.resolve(cachedTimeslots)
        : pb.collection('timeslot').getFullList({ sort: 'start' }),
      cachedRooms.length
        ? Promise.resolve(cachedRooms)
        : pb.collection('roomType').getFullList({
            sort: 'name',
            expand: 'teacher',
            filter: 'roomType = "grp"',
          }),
      pb.collection('dailySchedule').getFullList({
        filter: `date >= "${date} 00:00:00" && date <= "${dateStr}"`,
        expand: 'teacher,student,subject,room,timeslot,customSchedule',
      }),
    ])

    if (!cachedTimeslots.length) cachedTimeslots = timeslots
    if (!cachedRooms.length) cachedRooms = rooms

    return { timeslots, rooms, schedules }
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
      const { timeslots, rooms, schedules } = await fetchCoreData(selectedDate)

      const holiday = cachedHolidays.find((h) => h.date?.split(' ')[0] === selectedDate) || null
      todayHoliday = holiday

      const normalized = normalizeSchedules(schedules, selectedDate, holiday)

      const grpRoomIds = new Set(rooms.map((r) => r.id))
      const grpSchedules = normalized.filter((s) => grpRoomIds.has(s.roomId))

      const showCount = grpSchedules.filter((s) => s.status === 'show').length
      scheduleStatusSummary = {
        total: grpSchedules.length,
        showCount,
        draftCount: grpSchedules.length - showCount,
      }

      const scheduleMap = buildScheduleMap(normalized)
      const emptyCountMap = buildEmptyCountMapBySection(timeslots, rooms, scheduleMap)
      const { columns, data } = buildGridConfig(rooms, timeslots, scheduleMap, emptyCountMap)

      await renderGrid(columns, data, scroll)
    } catch (err) {
      console.error(err)
      toast.error('Failed to load schedules')
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

  async function refreshAfterClearDay() {
    cachedHolidays = await pb.collection('holiday').getFullList({ fields: 'id,name,date' })
    await loadSchedules(saveScroll())
  }

  // ─────────────────────────────────────────────
  // SECTION 11: Realtime subscription
  // ─────────────────────────────────────────────

  function handleRealtimeEvent(e) {
    const recDate = e.record?.date?.split(' ')[0]
    if (!recDate) return
    if (recDate !== selectedDate) return

    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => loadSchedules(saveScroll()), 500)
  }

  // ─────────────────────────────────────────────
  // SECTION 12: Lifecycle
  // ─────────────────────────────────────────────

  onMount(() => {
    let unsub = null

    fetchHolidays().catch((err) => console.warn('Failed to load holidays:', err))
    loadSchedules()

    // pb.collection('dailySchedule')
    //   .subscribe('*', handleRealtimeEvent)
    //   .then((fn) => {
    //     unsub = fn
    //   })

    return () => {
      gridInstance?.destroy()
      gridInstance = null
      clearTimeout(refreshTimer)
      // unsub?.()
    }
  })
</script>

<!-- ─────────────────────────────────────────── -->
<!-- TEMPLATE                                    -->
<!-- ─────────────────────────────────────────── -->

<div class="p-2 sm:p-4 md:p-6 bg-base-100">
  <!-- Header -->
  <div class="flex items-center justify-between mb-4 text-2xl font-bold">
    <div class="flex-1 flex flex-col items-start justify-center gap-0.5">
      {#if scheduleStatusSummary.showCount > 0}
        <span class="text-lg font-bold text-success">The teacher's schedule is now showing.</span>
      {:else if scheduleStatusSummary.total > 0}
        <span class="text-lg font-bold text-warning">The teachers' schedule is now hidden.</span>
      {/if}

      {#if scheduleStatusSummary.draftCount > 0}
        <span class="text-xs font-bold text-error">
          {scheduleStatusSummary.draftCount} schedule{scheduleStatusSummary.draftCount === 1 ? '' : 's'} still in draft
        </span>
      {/if}
    </div>

    <h2 class="text-center flex-1">Daily GRP Schedule</h2>

    <div class="flex-1 flex justify-end">
      <div class="w-6 h-6 flex items-center justify-center">
        {#if isLoading}
          <div class="loading loading-spinner loading-sm"></div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Date bar -->
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

    <!-- Center: formatted date -->
    <h3 class="text-xl font-semibold text-center">
      {formatDateDisplay(selectedDate)}
    </h3>

    <!-- Right: navigation controls -->
    <div class="flex items-center gap-2 justify-end">
      <button class="btn btn-outline btn-sm btn-error" onclick={() => clearDayModal.open()} disabled={isLoading}>
        Clear
      </button>
      <button class="btn btn-outline btn-sm" onclick={() => showStatusModal.open()} disabled={isLoading}> Show </button>
      <!-- <button class="btn btn-outline btn-sm" onclick={() => importModal.open()} disabled={isLoading}> Import </button> -->
      <button class="btn btn-outline btn-sm" onclick={() => copyModal.open()} disabled={isLoading}> Copy </button>
      <button
        class="btn btn-outline btn-sm"
        onclick={goToToday}
        disabled={isLoading || selectedDate === getTodayDate()}
      >
        Today
      </button>
      <button class="btn btn-outline btn-sm" onclick={() => changeDay(-1)} disabled={isLoading}> &larr; </button>
      <input
        type="date"
        class="input input-bordered input-sm w-auto"
        value={selectedDate}
        onchange={onDateChange}
        disabled={isLoading}
      />
      <button class="btn btn-outline btn-sm" onclick={() => changeDay(1)} disabled={isLoading}> &rarr; </button>
    </div>
  </div>

  <!-- Grid container — gridjs renders into this div -->
  <div id="daily-grid" class="rounded-lg"></div>
</div>

{#key selectedDate}
  <CombineModal bind:this={combineModal} onrefresh={refreshWithScroll} {selectedDate} />
{/key}

<CopyModal bind:this={copyModal} sourceDate={selectedDate} onrefresh={refreshWithScroll} roomType="grp" />
<ShowStatusModal bind:this={showStatusModal} sourceDate={selectedDate} roomType="grp" onrefresh={refreshWithScroll} />
<ClearDayModal bind:this={clearDayModal} {selectedDate} onrefresh={refreshAfterClearDay} roomType="grp" />

<ImportModal
  bind:this={importModal}
  {selectedDate}
  onrefresh={refreshWithScroll}
  roomType="grp"
  defaultRoomFilter="^[GH]\d+$"
/>

<!-- ─────────────────────────────────────────── -->
<!-- STYLES                                      -->
<!-- ─────────────────────────────────────────── -->

<style>
  :global(html) {
    scrollbar-gutter: stable;
  }

  /* Hover highlight on schedule cells */
  #daily-grid :global(.gridjs-table td:hover > div) {
    background-color: #d1fae5 !important;
    transition: background-color 0.2s ease;
    cursor: pointer;
  }

  /* Scrollable grid wrapper */
  #daily-grid :global(.gridjs-wrapper) {
    max-height: calc(100vh - 220px);
    overflow: auto;
    contain: layout;
    will-change: scroll-position;
  }

  /* Let cell background divs fill the full td area */
  #daily-grid :global(td) {
    padding: 0 !important;
    vertical-align: stretch;
    position: relative;
  }

  /* Sticky header row */
  #daily-grid :global(th) {
    position: sticky;
    top: 0;
    z-index: 20;
    background-color: #535252;
    color: #ffffff;
  }

  /* Sticky "Teacher" column */
  #daily-grid :global(th:nth-child(1)),
  #daily-grid :global(td:nth-child(1)) {
    position: sticky;
    left: 0;
    z-index: 15;
  }

  #daily-grid :global(th:nth-child(1)) {
    z-index: 25;
  }

  /* Sticky "Room" column */
  #daily-grid :global(th:nth-child(2)),
  #daily-grid :global(td:nth-child(2)) {
    position: sticky;
    left: 120px;
    z-index: 10;
  }

  #daily-grid :global(th:nth-child(2)) {
    z-index: 25;
  }

  #daily-grid :global(td:nth-child(1) div),
  #daily-grid :global(td:nth-child(2) div) {
    font-size: 0.85rem;
    font-weight: bold;
  }

  /* stronger table border */
  #daily-grid :global(.gridjs-table td),
  #daily-grid :global(.gridjs-table th) {
    outline: 1px solid #535252;
  }
</style>
