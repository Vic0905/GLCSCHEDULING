<script>
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../lib/Pocketbase.svelte'

  const BREAK_SCHEDULES = ['lunch break', 'break time', 'other task']

  let selectedDate = $state(getTodayDate())
  let selectedTimeslotId = $state(null)
  let timeslots = $state([])
  let allRooms = $state([])
  let rawRecords = $state([])
  let isLoading = $state(false)

  let cachedTimeslots = []
  let cachedRooms = []

  const A_RANGES = [
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
  ]

  const G_RANGES = [
    { label: 'G01-G11', min: 1, max: 11 },
    { label: 'G12-G18', min: 12, max: 18 },
    { label: 'G19-G34', min: 19, max: 34 },
  ]

  const B_RANGES = [
    { label: 'B01-B07', min: 1, max: 7 },
    { label: 'B08-B21', min: 8, max: 21 },
    { label: 'B22-B35', min: 22, max: 35 },
    { label: 'B36-B49', min: 36, max: 49 },
    { label: 'B50-B63', min: 50, max: 63 },
    { label: 'B64-B77', min: 64, max: 77 },
    { label: 'B78-B91', min: 78, max: 91 },
    { label: 'B92-B98', min: 92, max: 98 },
  ]

  const H_RANGES = [
    { label: 'H01-H10', min: 1, max: 10 },
    { label: 'H11-H16', min: 11, max: 16 },
  ]

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

  function getRoomSortKey(roomName) {
    if (!roomName) return { tier: 99, num: Infinity }
    const upper = roomName.toUpperCase()
    let tier
    if (upper.startsWith('ST')) tier = 1
    else if (upper.startsWith('A')) tier = 0
    else if (upper.startsWith('B')) tier = 2
    else if (upper.startsWith('G') || upper.startsWith('H')) tier = 3
    else tier = 4
    const num = parseInt(upper.replace(/\D/g, ''), 10)
    return { tier, num: isNaN(num) ? Infinity : num }
  }

  function byRoomNum(a, b) {
    return getRoomSortKey(a.room?.name).num - getRoomSortKey(b.room?.name).num
  }

  function getBreakInfo(group) {
    return group.customSchedule.find((cs) => BREAK_SCHEDULES.includes(cs.name?.toLowerCase().trim()))
  }

  function getCurrentTimeslotId(timeslotList) {
    const nowStr = new Date().toTimeString().slice(0, 5)
    const match = timeslotList.find((t) => nowStr >= t.start && nowStr < t.end)
    return match?.id || null
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

  // Every enabled room, bucketed into its aisle/section, each carrying
  // whatever scheduled groups (if any) matched it for this timeslot.
  let categorizedSchedules = $derived.by(() => {
    const mainMtm = A_RANGES.map((r) => ({ ...r, rooms: [] }))
    const mainGrp = G_RANGES.map((r) => ({ ...r, rooms: [] }))
    const annex2 = B_RANGES.map((r) => ({ ...r, rooms: [] }))
    const annex2Grp = H_RANGES.map((r) => ({ ...r, rooms: [] })) // NEW
    const stRooms = []
    const other = []

    const getNum = (name) => parseInt(name.replace(/\D/g, ''), 10)

    const groupsByRoom = new Map()
    for (const group of groupedSchedules) {
      if (!group.roomId) continue
      if (!groupsByRoom.has(group.roomId)) groupsByRoom.set(group.roomId, [])
      groupsByRoom.get(group.roomId).push(group)
    }

    for (const room of allRooms) {
      const roomName = room.name?.toUpperCase() || ''
      const num = getNum(roomName)
      const entry = { room, groups: groupsByRoom.get(room.id) || [] }

      if (roomName.startsWith('A') && !isNaN(num)) {
        const aisle = mainMtm.find((a) => num >= a.min && num <= a.max)
        if (aisle) aisle.rooms.push(entry)
        else other.push(entry)
      } else if (roomName.startsWith('G') && !isNaN(num)) {
        const aisle = mainGrp.find((a) => num >= a.min && num <= a.max)
        if (aisle) aisle.rooms.push(entry)
        else other.push(entry)
      } else if (roomName.startsWith('B') && !isNaN(num)) {
        const aisle = annex2.find((a) => num >= a.min && num <= a.max)
        if (aisle) aisle.rooms.push(entry)
        else other.push(entry)
      } else if (roomName.startsWith('H') && !isNaN(num)) {
        // NEW
        const aisle = annex2Grp.find((a) => num >= a.min && num <= a.max)
        if (aisle) aisle.rooms.push(entry)
        else other.push(entry)
      } else if (roomName.startsWith('ST')) {
        stRooms.push(entry)
      } else {
        other.push(entry)
      }
    }

    mainMtm.forEach((a) => a.rooms.sort(byRoomNum))
    mainGrp.forEach((a) => a.rooms.sort(byRoomNum))
    annex2.forEach((a) => a.rooms.sort(byRoomNum))
    annex2Grp.forEach((a) => a.rooms.sort(byRoomNum)) // NEW
    stRooms.sort(byRoomNum)
    other.sort(byRoomNum)

    return { mainMtm, mainGrp, annex2, annex2Grp, stRooms, other } // annex2Grp added
  })

  async function loadSchedules() {
    isLoading = true
    try {
      const date = selectedDate
      const [timeslotList, roomList, records] = await Promise.all([
        cachedTimeslots.length
          ? Promise.resolve(cachedTimeslots)
          : pb.collection('timeslot').getFullList({ sort: 'start' }),
        cachedRooms.length
          ? Promise.resolve(cachedRooms)
          : pb.collection('roomType').getFullList({
              filter: 'status = "enabled"',
              sort: 'name',
              expand: 'teacher',
            }),
        pb.collection('dailySchedule').getFullList({
          filter: `date >= "${date} 00:00:00" && date <= "${date} 23:59:59"`,
          expand: 'teacher,student,subject,room,timeslot,customSchedule,sub',
        }),
      ])

      if (!cachedTimeslots.length) cachedTimeslots = timeslotList
      if (!cachedRooms.length) cachedRooms = roomList
      timeslots = timeslotList
      allRooms = roomList
      rawRecords = records

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

  onMount(loadSchedules)
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
      <!-- MAIN BUILDING MTM (Aisle Boxes) -->
      <section>
        <div class="divider font-black text-lg text-primary uppercase mb-6">MAIN BUILDING MTM</div>
        <div class="flex flex-wrap justify-center gap-3">
          {#each categorizedSchedules.mainMtm as aisle (aisle.label)}
            {@render aisleContainer(aisle)}
          {/each}
        </div>
      </section>

      <!-- ST ROOMS (Loose Cards, not in aisles) -->
      {#if categorizedSchedules.stRooms.length > 0}
        <section>
          <div class="divider font-bold text-sm opacity-50 uppercase mb-4">ST Rooms</div>
          <div class="flex flex-wrap justify-center gap-3">
            {#each categorizedSchedules.stRooms as entry (entry.room.id)}
              <div class="w-full sm:w-[48%] md:w-[31%] lg:w-[19%]">
                {@render scheduleCard(entry)}
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- MAIN BUILDING GRP (Aisle Boxes) -->
      <section>
        <div class="divider font-black text-lg text-secondary uppercase mb-6">MAIN BUILDING GRP</div>
        <div class="flex flex-wrap justify-center gap-3">
          {#each categorizedSchedules.mainGrp as aisle (aisle.label)}
            {@render aisleContainer(aisle)}
          {/each}
        </div>
      </section>

      <!-- ANNEX 2 BUILDING MTM (Aisle Boxes) -->
      <section>
        <div class="divider font-black text-lg text-accent uppercase mb-6">ANNEX 2 BUILDING MTM</div>
        <div class="flex flex-wrap justify-center gap-3">
          {#each categorizedSchedules.annex2 as aisle (aisle.label)}
            {@render aisleContainer(aisle)}
          {/each}
        </div>
      </section>

      <!-- ANNEX 2 BUILDING GRP (Aisle Boxes) -->
      <section>
        <div class="divider font-black text-lg text-accent uppercase mb-6">ANNEX 2 BUILDING GRP</div>
        <div class="flex flex-wrap justify-center gap-3">
          {#each categorizedSchedules.annex2Grp as aisle (aisle.label)}
            {@render aisleContainer(aisle)}
          {/each}
        </div>
      </section>

      <!-- OTHER ROOMS (Loose Cards) -->
      {#if categorizedSchedules.other.length > 0}
        <section>
          <div class="divider font-bold text-sm opacity-50 uppercase mb-4">Other Rooms</div>
          <div class="flex flex-wrap justify-center gap-3">
            {#each categorizedSchedules.other as entry (entry.room.id)}
              <div class="w-full sm:w-[48%] md:w-[31%] lg:w-[19%]">
                {@render scheduleCard(entry)}
              </div>
            {/each}
          </div>
        </section>
      {/if}
    </div>
  {/if}
</div>
