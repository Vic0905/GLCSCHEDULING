<script>
  import { onDestroy, onMount, tick } from 'svelte'
  import { Grid, h } from 'gridjs'
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../lib/Pocketbase.svelte'
  import CustomSched from '../Information/Custom/customSched.svelte'
  //   import { pb } from '../../../lib/Pocketbase.svelte'

  // --- State Runes ---
  let selectedDate = $state(getTodayDate())
  let todayHoliday = $state(null)
  let isLoading = $state(false)
  let gridInstance = $state(null)

  // Cached data (load once)
  let cachedTimeslots = $state([])
  let cachedStudents = $state([])
  let cachedHolidays = $state([])
  let isStaticDataLoaded = $state(false)

  // Real-time subscriptions
  let unsubSchedule = null
  let refreshTimeout = null

  // Debounce helper
  let navigationInProgress = false

  // --- Helper Functions ---
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

  const changeDay = async (days) => {
    if (isLoading || navigationInProgress) return

    navigationInProgress = true

    const wrapper = document.querySelector('#student-grid .gridjs-wrapper')
    const savedScrollTop = wrapper?.scrollTop || 0
    const savedScrollLeft = wrapper?.scrollLeft || 0

    const d = new Date(selectedDate)
    d.setDate(d.getDate() + days)
    selectedDate = d.toISOString().split('T')[0]

    await loadStudentSchedule(savedScrollTop, savedScrollLeft)
    navigationInProgress = false
  }

  const onDateChange = async (e) => {
    if (isLoading || navigationInProgress) return

    navigationInProgress = true

    const wrapper = document.querySelector('#student-grid .gridjs-wrapper')
    const savedScrollTop = wrapper?.scrollTop || 0
    const savedScrollLeft = wrapper?.scrollLeft || 0

    selectedDate = e.target.value
    await loadStudentSchedule(savedScrollTop, savedScrollLeft)
    navigationInProgress = false
  }

  const goToToday = async () => {
    if (isLoading || navigationInProgress || selectedDate === getTodayDate()) return

    navigationInProgress = true

    const wrapper = document.querySelector('#student-grid .gridjs-wrapper')
    const savedScrollTop = wrapper?.scrollTop || 0
    const savedScrollLeft = wrapper?.scrollLeft || 0

    selectedDate = getTodayDate()
    await loadStudentSchedule(savedScrollTop, savedScrollLeft)
    navigationInProgress = false
  }

  const formatCell = (cell) => {
    const bgClass = cell?.bgClass || 'bg-white'
    const items = cell?.schedules || []

    if (!items.length) {
      return h(
        'div',
        { class: `w-full h-full min-h-[55px] flex items-center justify-center text-gray-400 ${bgClass}` },
        '—'
      )
    }

    // Break check
    const BREAK_SCHEDULES = ['lunch break', 'break time', 'other task']
    const firstCustomSchedules = items[0]?.customSchedule || []
    const breakSchedule = firstCustomSchedules.find((cs) => BREAK_SCHEDULES.includes(cs?.name?.toLowerCase().trim()))

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

    return h(
      'div',
      {
        class: `flex flex-col gap-1 p-2 items-center justify-center text-center w-full h-full${bgClass}`,
      },
      items.map((item) =>
        h(
          'div',
          { class: 'flex flex-col gap-1 w-full' },
          [
            h('div', { class: 'font-bold border-b border-neutral-500 mb-1 pb-1 w-full text-center' }, [
              h('div', {}, item.subject?.name || 'No Subject'),
              h('div', { class: 'text-xs uppercase mt-1' }, item.teacher?.name || 'No Teacher'),
            ]),
            item.room &&
              h(
                'div',
                { class: 'flex justify-center' },
                h('span', { class: 'text-xs font-semibold whitespace-nowrap' }, item.room.name)
              ),
            item.customSchedule?.length &&
              h(
                'div',
                { class: 'flex flex-wrap justify-center gap-1 mt-1' },
                item.customSchedule.map((cs) =>
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
          ].filter(Boolean)
        )
      )
    )
  }

  async function loadStaticData() {
    if (isStaticDataLoaded) return

    try {
      const [timeslots, holidays] = await Promise.all([
        pb.collection('timeslot').getFullList({ sort: 'start' }),
        pb.collection('holiday').getFullList({ fields: 'id,name,date' }),
      ])

      cachedTimeslots = timeslots
      cachedHolidays = holidays
      isStaticDataLoaded = true
    } catch (err) {
      console.error('Failed to load static data:', err)
      toast.error('Failed to load student data')
    }
  }

  async function loadStudentSchedule(savedScrollTop = null, savedScrollLeft = null) {
    if (isLoading) return

    isLoading = true
    try {
      const foundHoliday = cachedHolidays.find((h) => h.date?.split(' ')[0] === selectedDate)
      todayHoliday = foundHoliday || null

      const startDateStr = `${selectedDate} 00:00:00`
      const endDateStr = `${selectedDate} 23:59:59`

      // student collection keeps its own start/end range fields — no change here
      cachedStudents = await pb.collection('student').getFullList({
        filter: `status != "graduated" && start <= "${endDateStr}" && end >= "${startDateStr}"`,
        fields: 'id,studentId,name,englishName,course,level,groupName,status,start,created,remarks,colorRemark',
      })

      // Fetch dailySchedule records for the selected day
      let schedules = await pb.collection('dailySchedule').getFullList({
        batch: 2000,
        filter: `date >= "${startDateStr}" && date <= "${endDateStr}"`,
        expand: 'teacher,student,subject,room,customSchedule',
        fields: [
          'id,date,status,timeslot,student,subject,room,customSchedule',
          'expand.teacher.name',
          'expand.student.id,expand.student.studentId,expand.student.name,expand.student.englishName,expand.student.course,expand.student.level,expand.student.status,expand.student.remarks,expand.student.colorRemark',
          'expand.subject.name',
          'expand.room.name',
          'expand.customSchedule.name,expand.customSchedule.color',
        ].join(','),
      })

      // On a holiday, only show records whose date exactly matches
      // (already guaranteed by the filter above, kept for parity)
      if (todayHoliday) {
        schedules = schedules.filter((s) => s.date?.split(' ')[0] === selectedDate)
      }

      const scheduleMap = new Map()

      // Collect student records actually referenced by today's schedules
      const scheduledStudentMap = new Map()

      for (const s of schedules) {
        const timeslotId = s.timeslot
        if (!timeslotId) continue

        const entry = {
          subject: s.expand?.subject,
          teacher: s.expand?.teacher,
          room: s.expand?.room,
          customSchedule: s.expand?.customSchedule || [],
        }

        const studentList = Array.isArray(s.expand?.student)
          ? s.expand.student
          : s.expand?.student
            ? [s.expand.student]
            : []

        for (const student of studentList) {
          // Track which student record is tied to a schedule on this date
          if (!scheduledStudentMap.has(student.id)) {
            scheduledStudentMap.set(student.id, student)
          }

          if (!scheduleMap.has(student.id)) {
            scheduleMap.set(student.id, new Map())
          }
          const studentSlots = scheduleMap.get(student.id)
          if (!studentSlots.has(timeslotId)) {
            studentSlots.set(timeslotId, [])
          }
          studentSlots.get(timeslotId).push(entry)
        }
      }

      // Build deduplicated student list per date:
      // - Students with a schedule on this date use the record from the schedule expand
      // - Students with no schedule use the latest cached record per englishName
      // - Never show two records with the same englishName
      const seenNames = new Set()
      const resolvedStudents = []

      // First pass: students with schedules today take priority
      for (const [, student] of scheduledStudentMap) {
        const key = student.englishName?.toLowerCase()
        if (!key || seenNames.has(key)) continue
        seenNames.add(key)
        resolvedStudents.push(student)
      }

      // Second pass: remaining students from cache (no schedule today)
      // Use latest record per englishName for students not yet seen
      const latestByName = new Map()
      for (const s of cachedStudents) {
        const key = s.englishName?.toLowerCase()
        if (!key) continue
        if (!latestByName.has(key) || new Date(s.created) > new Date(latestByName.get(key).created)) {
          latestByName.set(key, s)
        }
      }

      for (const [key, student] of latestByName) {
        if (seenNames.has(key)) continue
        seenNames.add(key)
        resolvedStudents.push(student)
      }

      const students = resolvedStudents.sort((a, b) => {
        const aIsNew = a.status === 'new' ? 1 : 0
        const bIsNew = b.status === 'new' ? 1 : 0
        if (aIsNew !== bIsNew) return aIsNew - bIsNew
        return (a.studentId || '').localeCompare(b.studentId || '')
      })

      const data = students.map((student, i) => {
        const bgClass = i % 2 === 0 ? 'bg-white text-neutral-800' : 'bg-neutral-100 text-neutral-800'
        const studentSlots = scheduleMap.get(student.id) || new Map()

        const row = [
          { value: student.name, status: student.status, bgClass },
          { value: student.englishName || '', bgClass },
          { value: student.course || '', bgClass },
          { value: student.level || '', bgClass },
          { value: student.remarks || '', bgClass, colorRemark: student.colorRemark || null },
        ]

        for (const ts of cachedTimeslots) {
          const schedules = studentSlots.get(ts.id) || []
          row.push({ schedules, bgClass })
        }
        return row
      })

      const columns = [
        {
          name: 'Student',
          width: '180px',
          formatter: (cell) => {
            const statusBadges = {
              new: { class: 'badge-success badge', label: 'New' },
              extended: { class: 'badge-secondary badge', label: 'Extended' },
              changed: { class: 'badge-error badge', label: 'Changed' },
            }
            const badge = statusBadges[cell.status]
            return h(
              'div',
              {
                class: `w-full h-full p-2 flex flex-col items-center justify-center text-center min-h-[65px] ${cell.bgClass || 'bg-white'}`,
              },
              [
                h('span', { class: 'font-bold text-neutral-700' }, cell.value),
                badge && h('span', { class: `badge ${badge.class} badge-xs mt-1` }, badge.label),
              ].filter(Boolean)
            )
          },
        },
        {
          name: 'English Name',
          width: '140px',
          formatter: (cell) =>
            h(
              'div',
              {
                class: `w-full h-full p-2 flex items-center justify-center font-semibold text-neutral-700 text-center ${cell.bgClass || 'bg-white'}`,
              },
              cell.value
            ),
        },
        {
          name: 'Course',
          width: '120px',
          formatter: (cell) =>
            h(
              'div',
              {
                class: `w-full h-full p-2 flex items-center justify-center font-semibold text-neutral-700 text-center ${cell.bgClass || 'bg-white'}`,
              },
              cell.value
            ),
        },
        {
          name: 'Level',
          width: '120px',
          formatter: (cell) =>
            h(
              'div',
              {
                class: `w-full h-full p-2 flex items-center justify-center font-semibold text-neutral-700 text-center ${cell.bgClass || 'bg-white'}`,
              },
              cell.value
            ),
        },
        {
          name: 'Remarks',
          width: '120px',
          formatter: (cell) => {
            const baseBg = (cell.bgClass || '').includes('neutral-100') ? '#f5f5f5' : '#ffffff'
            const style = cell.colorRemark
              ? `background: linear-gradient(${cell.colorRemark}20, ${cell.colorRemark}20), ${baseBg}; color:${cell.colorRemark};`
              : ''
            return h(
              'div',
              {
                class: `w-full h-full p-2 flex items-center justify-center font-semibold text-neutral-700 text-center ${cell.bgClass || 'bg-white'}`,
                style,
              },
              cell.value
            )
          },
        },
        ...cachedTimeslots.map((ts) => ({
          id: ts.id,
          width: '200px',
          name: h('div', { class: 'flex flex-col items-center gap-0.5' }, [h('span', null, `${ts.start} - ${ts.end}`)]),
          formatter: formatCell,
        })),
      ]

      await tick()

      if (gridInstance && document.getElementById('student-grid')) {
        gridInstance.updateConfig({ columns, data }).forceRender()

        if (savedScrollTop !== null) {
          requestAnimationFrame(() => {
            const wrapper = document.querySelector('#student-grid .gridjs-wrapper')
            if (wrapper) {
              wrapper.scrollTop = savedScrollTop
              wrapper.scrollLeft = savedScrollLeft || 0
            }
          })
        }
      } else {
        gridInstance = new Grid({
          columns,
          data,
          height: 'calc(100vh - 220px)',
          search: {
            selector: (cell) => {
              if (!cell || typeof cell !== 'object') return String(cell ?? '')
              if ('value' in cell) return cell.value ?? ''
              if (!cell.schedules?.length) return ''
              return cell.schedules
                .flatMap((s) => [s.subject?.name ?? '', s.teacher?.name ?? '', s.room?.name ?? ''])
                .join(' ')
            },
          },
          sort: false,
          pagination: false,
          className: {
            table: 'table w-full',
            th: 'text-center',
            td: 'text-center',
            search: 'input input-sm m-5',
            pagination: 'flex flex-row justify-between mt-5',
            paginationButton: 'btn btn-sm',
          },
          style: { table: { 'table-layout': 'fixed' } },
        }).render(document.getElementById('student-grid'))
      }
    } catch (err) {
      console.error('Failed to load student schedule:', err)
      toast.error('Failed to load student schedule')
    } finally {
      isLoading = false
    }
  }

  async function refreshWithScroll() {
    if (refreshTimeout) clearTimeout(refreshTimeout)

    refreshTimeout = setTimeout(async () => {
      const wrapper = document.querySelector('#student-grid .gridjs-wrapper')
      const savedScrollTop = wrapper?.scrollTop || 0
      const savedScrollLeft = wrapper?.scrollLeft || 0
      await loadStudentSchedule(savedScrollTop, savedScrollLeft)
      refreshTimeout = null
    }, 100)
  }

  onMount(async () => {
    await loadStaticData()
    await loadStudentSchedule()

    unsubSchedule = await pb.collection('dailySchedule').subscribe('*', (e) => {
      const recDate = e.record?.date?.split(' ')[0]
      if (!recDate || recDate !== selectedDate) return
      refreshWithScroll()
    })
  })

  onDestroy(() => {
    if (refreshTimeout) clearTimeout(refreshTimeout)
    unsubSchedule?.()
    if (gridInstance) {
      gridInstance.destroy()
      gridInstance = null
    }
  })
</script>

<div class="p-2 sm:p-4 md:p-6 bg-base-100">
  <div class="flex items-center justify-between mb-4 text-2xl font-bold">
    <h2 class="text-center flex-1">Student Daily View</h2>
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

  <div id="student-grid" class="rounded-lg"></div>
</div>

<style>
  :global(html) {
    scrollbar-gutter: stable;
  }

  #student-grid :global(.gridjs-wrapper) {
    max-height: calc(100vh - 220px);
    overflow: auto;
    contain: layout;
    will-change: scroll-position;
  }

  /* Fix padding and alignment */
  #student-grid :global(td) {
    padding: 0 !important;
    vertical-align: stretch;
    position: relative;
  }

  #student-grid :global(th) {
    position: sticky;
    top: 0;
    z-index: 20;
    background-color: #535252;
    color: #ffffff;
  }

  /* Sticky columns for student info */
  #student-grid :global(th:nth-child(1)),
  #student-grid :global(td:nth-child(1)) {
    position: sticky;
    left: 0;
    z-index: 15;
  }

  #student-grid :global(th:nth-child(1)) {
    z-index: 25;
  }

  #student-grid :global(th:nth-child(2)),
  #student-grid :global(td:nth-child(2)) {
    position: sticky;
    left: 180px;
    z-index: 10;
  }

  #student-grid :global(th:nth-child(2)) {
    z-index: 25;
  }

  #student-grid :global(th:nth-child(3)),
  #student-grid :global(td:nth-child(3)) {
    position: sticky;
    left: 320px;
    z-index: 10;
  }

  #student-grid :global(th:nth-child(3)) {
    z-index: 25;
  }

  #student-grid :global(th:nth-child(4)),
  #student-grid :global(td:nth-child(4)) {
    position: sticky;
    left: 440px;
    z-index: 10;
  }

  #student-grid :global(th:nth-child(4)) {
    z-index: 25;
  }

  #student-grid :global(th:nth-child(5)),
  #student-grid :global(td:nth-child(5)) {
    position: sticky;
    left: 560px;
    z-index: 10;
  }

  #student-grid :global(th:nth-child(5)) {
    z-index: 25;
  }

  /* font bold for teacher and room td */
  #student-grid :global(td:nth-child(1) div),
  #student-grid :global(td:nth-child(2) div),
  #student-grid :global(td:nth-child(3) div),
  #student-grid :global(td:nth-child(4) div),
  #student-grid :global(td:nth-child(5) div) {
    font-size: 0.85rem;
    font-weight: bold;
  }

  /* stronger table border */
  #student-grid :global(.gridjs-table td),
  #student-grid :global(.gridjs-table th) {
    outline: 1px solid #535252;
  }
</style>
