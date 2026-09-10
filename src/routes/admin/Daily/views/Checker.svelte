<script>
  import { onDestroy, onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../lib/Pocketbase.svelte'

  const BREAK_SCHEDULES = ['lunch break', 'break time', 'other task']

  // Single source of truth for every room category: which name prefix it
  // matches, its section label/styling, whether it renders as an "aisle"
  // grid (with sub-ranges) or a "loose" flat list, and its aisle ranges
  // if applicable. Add/edit a building or aisle range here only.
  const CATEGORY_DEFS = [
    {
      key: 'mainMtm',
      prefix: 'A',
      label: 'MAIN BUILDING MTM',
      headerClass: 'font-black text-lg text-primary mb-6',
      layout: 'aisle',
      ranges: [
        { label: 'A001-A005', min: 1, max: 5 },
        { label: 'A006-A018', min: 6, max: 18 },
        { label: 'A019-A033', min: 19, max: 33 },
        { label: 'A034-A049', min: 34, max: 49 },
        { label: 'A050-A064', min: 50, max: 64 },
        { label: 'A065-A073', min: 65, max: 73 },
        { label: 'A074-A083', min: 74, max: 83 },
        { label: 'A084-A092', min: 84, max: 92 },
        { label: 'A093-A101', min: 93, max: 101 },
        { label: 'A102-A109', min: 102, max: 109 },
        { label: 'A110-A125', min: 110, max: 125 },
        { label: 'A126-A141', min: 126, max: 141 },
        { label: 'A142-A157', min: 142, max: 157 },
      ],
    },
    {
      key: 'stRooms',
      prefix: 'ST',
      label: 'ST Rooms',
      headerClass: 'font-bold text-sm opacity-50 mb-4',
      layout: 'loose',
    },
    {
      key: 'mainGrp',
      prefix: 'G',
      label: 'MAIN BUILDING GRP',
      headerClass: 'font-black text-lg text-secondary mb-6',
      layout: 'aisle',
      ranges: [
        { label: 'G01-G11', min: 1, max: 11 },
        { label: 'G12-G18', min: 12, max: 18 },
        { label: 'G19-G34', min: 19, max: 34 },
      ],
    },
    {
      key: 'annex2',
      prefix: 'B',
      label: 'ANNEX 2 BUILDING MTM',
      headerClass: 'font-black text-lg text-accent mb-6',
      layout: 'aisle',
      ranges: [
        { label: 'B01-B07', min: 1, max: 7 },
        { label: 'B08-B21', min: 8, max: 21 },
        { label: 'B22-B35', min: 22, max: 35 },
        { label: 'B36-B49', min: 36, max: 49 },
        { label: 'B50-B63', min: 50, max: 63 },
        { label: 'B64-B77', min: 64, max: 77 },
        { label: 'B78-B91', min: 78, max: 91 },
        { label: 'B92-B98', min: 92, max: 98 },
      ],
    },
    {
      key: 'annex2Grp',
      prefix: 'H',
      label: 'ANNEX 2 BUILDING GRP',
      headerClass: 'font-black text-lg text-accent mb-6',
      layout: 'aisle',
      ranges: [
        { label: 'H01-H10', min: 1, max: 10 },
        { label: 'H11-H16', min: 11, max: 16 },
      ],
    },
    {
      // Catch-all: no prefix, so categorizeRoom() only lands here when
      // nothing else matched (unknown prefix, or a number outside every
      // range above).
      key: 'other',
      label: 'Other Rooms',
      headerClass: 'font-bold text-sm opacity-50 mb-4',
      layout: 'loose',
    },
  ]

  let selectedDate = $state(getTodayDate())
  let selectedTimeslotId = $state(null)
  let timeslots = $state([])
  let allRooms = $state([])
  let rawRecords = $state([])
  let rawAttendance = $state([])
  let isLoading = $state(false)

  // One collapse flag per category, derived from CATEGORY_DEFS so adding a
  // new category automatically gets a toggle without touching this line.
  let collapsedSections = $state(Object.fromEntries(CATEGORY_DEFS.map((c) => [c.key, false])))

  let cache = { timeslots: [], rooms: [] }
  let unsubAttendance = null

  let currentTeacherId = $derived(pb.authStore.model?.id ?? null)
  // Admins can flip anyone's attendance status, not just their own.
  let isAdmin = $derived(pb.authStore.model?.role === 'admin')

  function getTodayDate() {
    return new Date().toISOString().split('T')[0]
  }

  function formatDateDisplay(dateStr) {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  }

  function offsetDate(dateStr, days) {
    const d = new Date(dateStr)
    d.setDate(d.getDate() + days)
    return d.toISOString().split('T')[0]
  }

  function getRoomNum(roomName) {
    const num = parseInt((roomName || '').replace(/\D/g, ''), 10)
    return isNaN(num) ? Infinity : num
  }

  function byRoomNum(a, b) {
    return getRoomNum(a.room?.name) - getRoomNum(b.room?.name)
  }

  function getBreakInfo(group) {
    return group.customSchedule.find((cs) => BREAK_SCHEDULES.includes(cs.name?.toLowerCase().trim()))
  }

  function getCurrentTimeslotId(timeslotList) {
    const nowStr = new Date().toTimeString().slice(0, 5)
    const match = timeslotList.find((t) => nowStr >= t.start && nowStr < t.end)
    return match?.id || null
  }

  function toggleSection(key) {
    collapsedSections[key] = !collapsedSections[key]
  }

  function attendanceKey(teacherId, roomId, timeslotId) {
    return `${teacherId}-${roomId}-${timeslotId}`
  }

  // Decides which category (and, for aisle layouts, which sub-range) a
  // room belongs to. Replaces the old startsWith/isNaN if-elif chain.
  function categorizeRoom(roomName) {
    const upper = (roomName || '').toUpperCase()
    const num = getRoomNum(upper)
    const cat = CATEGORY_DEFS.find((c) => c.prefix && upper.startsWith(c.prefix))
    if (!cat) return { key: 'other' }
    if (!cat.ranges) return { key: cat.key }
    const range = cat.ranges.find((r) => num >= r.min && num <= r.max)
    return range ? { key: cat.key, rangeLabel: range.label } : { key: 'other' }
  }

  // Raw scheduled records for the selected timeslot, grouped by teacher+room
  // (a room can theoretically have more than one teacher/group in the same
  // timeslot, e.g. a sub handoff, so we keep this as a list per room).
  let groupedSchedules = $derived.by(() => {
    if (!selectedTimeslotId) return []
    const map = new Map()
    for (const r of rawRecords) {
      if (r.expand?.timeslot?.id !== selectedTimeslotId) continue
      const teacherId = r.expand?.teacher?.id
      const roomId = r.expand?.room?.id
      const key = `${teacherId}-${roomId}`

      if (!map.has(key)) {
        map.set(key, {
          key,
          roomId,
          teacher: r.expand?.teacher || null,
          room: r.expand?.room || null,
          subject: r.expand?.subject || null,
          sub: r.expand?.sub || null,
          customSchedule: r.expand?.customSchedule || [],
          students: [],
        })
      }
      if (r.expand?.student) {
        map.get(key).students.push(r.expand.student.englishName)
      }
    }
    return [...map.values()]
  })

  // Attendance lookup keyed by teacher-room-timeslot for the selected date
  let attendanceMap = $derived.by(() => {
    const map = new Map()
    for (const a of rawAttendance) {
      map.set(attendanceKey(a.teacher, a.room, a.timeslot), a)
    }
    return map
  })

  // Every enabled room, bucketed by CATEGORY_DEFS (into aisle sub-ranges
  // where applicable), each carrying whatever scheduled groups matched it.
  let categorizedSchedules = $derived.by(() => {
    const buckets = {}
    for (const cat of CATEGORY_DEFS) {
      buckets[cat.key] = cat.ranges ? cat.ranges.map((r) => ({ ...r, rooms: [] })) : []
    }

    const groupsByRoom = new Map()
    for (const group of groupedSchedules) {
      if (!group.roomId) continue
      if (!groupsByRoom.has(group.roomId)) groupsByRoom.set(group.roomId, [])
      groupsByRoom.get(group.roomId).push(group)
    }

    for (const room of allRooms) {
      const entry = { room, groups: groupsByRoom.get(room.id) || [] }
      const { key, rangeLabel } = categorizeRoom(room.name)
      if (rangeLabel) {
        buckets[key].find((a) => a.label === rangeLabel).rooms.push(entry)
      } else {
        buckets[key].push(entry)
      }
    }

    for (const cat of CATEGORY_DEFS) {
      if (cat.ranges) buckets[cat.key].forEach((a) => a.rooms.sort(byRoomNum))
      else buckets[cat.key].sort(byRoomNum)
    }

    return buckets
  })

  async function getCached(key, fetcher) {
    if (!cache[key].length) cache[key] = await fetcher()
    return cache[key]
  }

  async function loadSchedules() {
    isLoading = true
    try {
      const date = selectedDate
      const [timeslotList, roomList, records, attendance] = await Promise.all([
        getCached('timeslots', () => pb.collection('timeslot').getFullList({ sort: 'start' })),
        getCached('rooms', () =>
          pb.collection('roomType').getFullList({ filter: 'status = "enabled"', sort: 'name', expand: 'teacher' })
        ),
        pb.collection('dailySchedule').getFullList({
          filter: `date >= "${date} 00:00:00" && date <= "${date} 23:59:59"`,
          expand: 'teacher,student,subject,room,timeslot,customSchedule,sub',
        }),
        pb.collection('teacherAttendance').getFullList({
          filter: `date = "${date}"`,
        }),
      ])

      timeslots = timeslotList
      allRooms = roomList
      rawRecords = records
      rawAttendance = attendance

      if (!selectedTimeslotId || !timeslots.some((t) => t.id === selectedTimeslotId)) {
        const autoId = date === getTodayDate() ? getCurrentTimeslotId(timeslots) : null
        selectedTimeslotId = autoId || timeslots[0]?.id || null
      }
    } catch (err) {
      console.error(err)
      toast.error('Failed to load schedule')
    } finally {
      isLoading = false
    }
  }

  // Applies a single realtime SSE event ({ action, record }) to local state
  // without refetching everything. Ignores events for a date other than
  // the one currently on screen.
  function applyAttendanceEvent({ action, record }) {
    if (record.date !== selectedDate) return

    if (action === 'create' || action === 'update') {
      const idx = rawAttendance.findIndex((a) => a.id === record.id)
      if (idx === -1) {
        rawAttendance = [...rawAttendance, record]
      } else {
        rawAttendance = rawAttendance.map((a) => (a.id === record.id ? record : a))
      }
    } else if (action === 'delete') {
      rawAttendance = rawAttendance.filter((a) => a.id !== record.id)
    }
  }

  // Allowed if you own the record, or if you're an admin acting on
  // someone else's.
  async function toggleCheckIn(group) {
    const effectiveTeacherId = group.sub?.id || group.teacher?.id
    const roomId = group.roomId

    if (effectiveTeacherId !== currentTeacherId && !isAdmin) return
    if (!roomId || !selectedTimeslotId) return

    const key = attendanceKey(effectiveTeacherId, roomId, selectedTimeslotId)
    const existing = attendanceMap.get(key)

    try {
      if (existing) {
        await pb.collection('teacherAttendance').delete(existing.id)
      } else {
        await pb.collection('teacherAttendance').create({
          teacher: effectiveTeacherId,
          room: roomId,
          timeslot: selectedTimeslotId,
          date: selectedDate,
          status: 'present',
        })
      }
    } catch (err) {
      console.error(err)
      toast.error('Failed to update check-in')
    }
  }

  async function changeDay(days) {
    selectedDate = offsetDate(selectedDate, days)
    await loadSchedules()
  }

  async function onDateChange(e) {
    selectedDate = e.target.value
    await loadSchedules()
  }

  async function goToToday() {
    selectedDate = getTodayDate()
    await loadSchedules()
  }

  onMount(async () => {
    await loadSchedules()
    unsubAttendance = await pb.collection('teacherAttendance').subscribe('*', applyAttendanceEvent)
  })

  onDestroy(() => {
    unsubAttendance?.()
  })
</script>

{#snippet scheduleCard(entry)}
  <!-- Compact inner card for individual rooms to fit inside the aisle box -->
  <div class="card bg-base-100 border border-base-200 shadow-sm w-full mb-2 last:mb-0">
    <div class="card-body p-2">
      {#if entry.groups.length === 0}
        <!-- No class scheduled in this room for the selected timeslot -->
        <div class="flex items-center justify-between text-xs opacity-40">
          <span class="font-bold">{entry.room?.name || 'No Room'}</span>
          <span class="italic">No class</span>
        </div>
        {#if entry.room?.expand?.teacher}
          <div class="text-[10px] opacity-40 text-center mt-1">
            {entry.room.expand.teacher.name}
          </div>
        {/if}
      {:else}
        {#each entry.groups as group (group.key)}
          {@const breakInfo = getBreakInfo(group)}
          {#if breakInfo}
            <div
              class="text-center font-bold text-xs py-1 rounded"
              style={breakInfo.color
                ? `background:${breakInfo.color}20; color:${breakInfo.color};`
                : 'background:#f3f4f6; color:#6b7280;'}
            >
              {breakInfo.name.toUpperCase()}
            </div>
            <div class="text-[10px] opacity-60 text-center mt-1">{group.teacher?.name || '—'}</div>
          {:else}
            {@const effectiveTeacherId = group.sub?.id || group.teacher?.id}
            {@const attendance = attendanceMap.get(
              attendanceKey(effectiveTeacherId, entry.room.id, selectedTimeslotId)
            )}
            {@const isOwner = effectiveTeacherId === currentTeacherId}
            {@const canToggle = isOwner || isAdmin}
            <div>
              <div class="flex items-center justify-between text-xs">
                <span class="font-bold text-primary">{group.room?.name || entry.room?.name || 'No Room'}</span>
                <span class="opacity-60 truncate max-w-[60%] text-right">{group.subject?.name || 'No Subject'}</span>
              </div>
              <div class="text-[11px] mt-1">
                <span class="opacity-60">Teacher:</span>
                <span class="font-semibold">{group.teacher?.name || '—'}</span>
              </div>
              {#if group.sub}
                <div class="text-[11px] text-info font-semibold">Sub: {group.sub.name}</div>
              {/if}
              {#if group.students.length}
                <div class="flex flex-wrap gap-1 mt-1">
                  <span class="text-[10px] opacity-60">Student(s):</span>
                  <span class="text-[10px] font-medium">{group.students.join(', ')}</span>
                </div>
              {/if}

              <!-- Presence -->
              {#if canToggle}
                <button
                  class="btn btn-xs btn-ghost w-full mt-2 font-bold {attendance ? 'text-success' : 'text-error'}"
                  onclick={() => toggleCheckIn(group)}
                >
                  {attendance ? '✓ Present' : 'Absent'}
                </button>
              {:else}
                <div
                  class="text-[11px] mt-2 text-center font-bold {attendance ? 'text-success' : 'text-error opacity-60'}"
                >
                  {attendance ? '✓ Present' : 'Absent'}
                </div>
              {/if}
            </div>
          {/if}
        {/each}
      {/if}
    </div>
  </div>
{/snippet}

{#snippet aisleContainer(aisleObj)}
  <!-- Aisle Box Container mirroring the physical grid blocks -->
  <div
    class="card bg-base-200 border-2 border-base-300 shadow-md w-full sm:w-[48%] md:w-[31%] lg:w-[19%] flex-shrink-0"
  >
    <div class="bg-neutral text-neutral-content text-center font-bold text-xs py-2 rounded-t-box">
      {aisleObj.label}
    </div>
    <div class="card-body p-2 min-h-[120px] flex flex-col justify-start">
      {#if aisleObj.rooms.length === 0}
        <div class="text-center text-xs opacity-40 mt-4 italic">No rooms in range</div>
      {:else}
        {#each aisleObj.rooms as entry (entry.room.id)}
          {@render scheduleCard(entry)}
        {/each}
      {/if}
    </div>
  </div>
{/snippet}

{#snippet sectionHeader(cat)}
  <!-- Clickable divider that toggles this category's body below it -->
  <button
    type="button"
    class="divider {cat.headerClass} uppercase w-full cursor-pointer select-none hover:opacity-80"
    onclick={() => toggleSection(cat.key)}
    aria-expanded={!collapsedSections[cat.key]}
  >
    <span class="inline-flex items-center gap-2">
      {cat.label}
      <span class="text-sm transition-transform {collapsedSections[cat.key] ? '-rotate-90' : ''}">▾</span>
    </span>
  </button>
{/snippet}

<div class="p-3 sm:p-4 md:p-6 bg-base-100 min-h-screen max-w-7xl mx-auto">
  <!-- Date bar -->
  <div class="flex flex-col gap-2 mb-4 bg-base-200 p-4 rounded-box shadow-sm border border-base-300">
    <div class="flex items-center justify-between">
      <h2 class="text-lg sm:text-xl font-bold">{formatDateDisplay(selectedDate)}</h2>
      {#if isLoading}
        <div class="loading loading-spinner loading-sm"></div>
      {/if}
    </div>

    <div class="flex items-center gap-2">
      <button
        class="btn btn-outline btn-sm bg-base-100"
        onclick={goToToday}
        disabled={isLoading || selectedDate === getTodayDate()}
      >
        Today
      </button>
      <button class="btn btn-outline btn-sm bg-base-100" onclick={() => changeDay(-1)} disabled={isLoading}
        >&larr;</button
      >
      <input
        type="date"
        class="input input-bordered input-sm flex-1 bg-base-100"
        value={selectedDate}
        onchange={onDateChange}
        disabled={isLoading}
      />
      <button class="btn btn-outline btn-sm bg-base-100" onclick={() => changeDay(1)} disabled={isLoading}
        >&rarr;</button
      >
    </div>
  </div>

  <!-- Timeslot chips -->
  <div class="flex gap-2 overflow-x-auto pb-2 mb-6 -mx-1 px-1">
    {#each timeslots as ts (ts.id)}
      <button
        class="btn btn-sm shrink-0 {selectedTimeslotId === ts.id ? 'btn-primary' : 'btn-outline bg-base-100'}"
        onclick={() => (selectedTimeslotId = ts.id)}
      >
        {ts.start} - {ts.end}
      </button>
    {/each}
  </div>

  <!-- Board Layout -->
  {#if !isLoading && allRooms.length === 0}
    <div class="text-center text-sm opacity-50 py-10">No rooms found.</div>
  {:else}
    <div class="flex flex-col gap-10">
      <!-- One loop drives every category (aisle grids + loose lists) -->
      {#each CATEGORY_DEFS as cat (cat.key)}
        {@const bucket = categorizedSchedules[cat.key]}
        {#if cat.layout === 'aisle' || bucket.length > 0}
          <section>
            {@render sectionHeader(cat)}
            {#if !collapsedSections[cat.key]}
              <div class="flex flex-wrap justify-center gap-3">
                {#if cat.layout === 'aisle'}
                  {#each bucket as aisle (aisle.label)}
                    {@render aisleContainer(aisle)}
                  {/each}
                {:else}
                  {#each bucket as entry (entry.room.id)}
                    <div class="w-full sm:w-[48%] md:w-[31%] lg:w-[19%]">
                      {@render scheduleCard(entry)}
                    </div>
                  {/each}
                {/if}
              </div>
            {/if}
          </section>
        {/if}
      {/each}
    </div>
  {/if}
</div>
