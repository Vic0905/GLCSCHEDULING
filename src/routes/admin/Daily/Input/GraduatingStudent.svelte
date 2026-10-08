<script>
  import { onMount } from 'svelte'
  import { Grid } from 'gridjs'
  import 'gridjs/dist/theme/mermaid.css'
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../lib/Pocketbase.svelte'

  // Graduation is held 1 day BEFORE the student's end date (end = Sat, graduation = Fri).
  // Change this number if the gap ever changes. Set to 0 to use the end date as-is.
  const GRADUATION_OFFSET_DAYS = 1

  let gridInstance = $state(null)
  let isLoading = $state(false)
  let weekStart = $state(getWeekStart(new Date()))

  // Format a Date as YYYY-MM-DD using LOCAL time (toISOString() uses UTC and can shift the day)
  function toDateStr(d) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  // Identifies "the same student" across records. Extended/changed records copy the
  // original's linked user, so that's the safest key. Falls back to English Name
  // for older records that have no user.
  function personKey(s) {
    const user = Array.isArray(s.user) ? s.user[0] : s.user
    return user || `name:${(s.englishName || '').toLowerCase()}`
  }

  // Parse YYYY-MM-DD as LOCAL midnight
  function parseLocalDate(str) {
    return new Date(`${str}T00:00:00`)
  }

  function getWeekStart(date) {
    const d = new Date(date)
    const day = d.getDay() // Sunday = 0 ... Saturday = 6
    d.setDate(d.getDate() - day) // always lands on Sunday
    return toDateStr(d)
  }

  function getWeekRangeDisplay(startDate) {
    const start = parseLocalDate(startDate)
    const end = new Date(start)
    end.setDate(start.getDate() + 6) // Sunday + 6 days = Saturday

    const opts = { month: 'long', day: 'numeric' }

    return `${start.toLocaleDateString('en-US', opts)} - ${end.toLocaleDateString('en-US', {
      ...opts,
      year: 'numeric',
    })}`
  }

  async function loadGraduatingStudents() {
    if (isLoading) return

    isLoading = true

    try {
      // The week shown is the week of the GRADUATION date (Sun - Sat).
      // Since graduation = end - OFFSET, the matching end dates are shifted forward by OFFSET.
      // Example: week Sun Jan 5 - Sat Jan 11, offset 1 -> end dates Mon Jan 6 - Sun Jan 12
      // (so a Saturday end date of Jan 11 shows up with a Friday Jan 10 graduation).
      const rangeStart = parseLocalDate(weekStart)
      rangeStart.setDate(rangeStart.getDate() + GRADUATION_OFFSET_DAYS)

      const rangeEnd = parseLocalDate(weekStart)
      rangeEnd.setDate(rangeEnd.getDate() + 6 + GRADUATION_OFFSET_DAYS)

      const startDateStr = `${toDateStr(rangeStart)} 00:00:00`
      const endDateStr = `${toDateStr(rangeEnd)} 23:59:59`

      const weekStudents = await pb.collection('student').getFullList({
        filter: `end >= "${startDateStr}" && end <= "${endDateStr}"`,
        sort: 'end',
      })

      // Hide students who were extended.
      // "Extend" in Student Info creates a NEW record (same linked user, later end date)
      // and keeps the original, so the original would still look like it's graduating.
      // If the same person has any record ending later, they are not graduating yet.
      const laterRecords = await pb.collection('student').getFullList({
        filter: `end >= "${startDateStr}"`,
        fields: 'id,user,englishName,end',
      })

      const latestEnd = new Map() // person -> latest end date (YYYY-MM-DD) across all their records
      for (const r of laterRecords) {
        if (!r.end) continue
        const key = personKey(r)
        const endDay = r.end.slice(0, 10)
        if (!latestEnd.has(key) || endDay > latestEnd.get(key)) latestEnd.set(key, endDay)
      }

      const students = weekStudents.filter((s) => {
        const later = latestEnd.get(personKey(s))
        return !(later && later > s.end.slice(0, 10))
      })

      const data = students.map((s) => {
        // Graduation date = end date minus the offset
        const graduationDate = new Date(s.end)
        graduationDate.setDate(graduationDate.getDate() - GRADUATION_OFFSET_DAYS)

        return [
          s.englishName || '-',
          s.name || '-',
          s.course || '-',
          s.level || '-',
          s.remarks || '-',
          s.status || '-',
          graduationDate.toLocaleDateString(),
        ]
      })

      const columns = [
        { name: 'English Name', width: '220px' },
        { name: 'Name', width: '220px' },
        { name: 'Course', width: '180px' },
        { name: 'Level', width: '120px' },
        { name: 'Remarks', width: '180px' },
        { name: 'Status', width: '120px' },
        { name: 'Graduation Date', width: '150px' },
      ]

      if (gridInstance) {
        gridInstance.updateConfig({ columns, data }).forceRender()
      } else {
        gridInstance = new Grid({
          columns,
          data,
          search: true,
          sort: true,
          pagination: { limit: 10 },
          className: {
            table: 'w-full border text-sm',
            th: 'text-center',
            td: 'text-center',
          },
        }).render(document.getElementById('graduating-grid'))
      }
    } catch (err) {
      console.error(err)
      toast.error('Failed to load graduating students')
    } finally {
      isLoading = false
    }
  }

  async function changeWeek(weeks) {
    const d = parseLocalDate(weekStart)
    d.setDate(d.getDate() + weeks * 7)
    weekStart = getWeekStart(d)
    await loadGraduatingStudents()
  }

  onMount(() => {
    loadGraduatingStudents()
    return () => {
      if (gridInstance) {
        gridInstance.destroy()
        gridInstance = null
      }
    }
  })
</script>

<div class="p-6 bg-base-100">
  <div class="flex items-center justify-between mb-4 text-2xl font-bold">
    <h2 class="text-2xl text-center font-bold flex-1">Graduating Students</h2>

    {#if isLoading}
      <div class="loading loading-spinner loading-sm"></div>
    {/if}
  </div>

  <div class="mb-2 flex flex-wrap items-center justify-between relative">
    <h3 class="absolute left-1/2 -translate-x-1/2 text-xl font-semibold">
      {getWeekRangeDisplay(weekStart)}
    </h3>

    <div class="ml-auto flex items-center gap-2">
      <button class="btn btn-outline btn-sm" onclick={() => changeWeek(-1)}> ← Previous Week </button>
      <button class="btn btn-outline btn-sm" onclick={() => changeWeek(1)}> Next Week → </button>
    </div>
  </div>

  <div id="graduating-grid" class=""></div>
</div>

<style>
  #graduating-grid :global(th) {
    background-color: #484b4f;
    color: white;
  }

  #graduating-grid :global(.gridjs-search) {
    margin-bottom: 1rem;
  }
</style>
