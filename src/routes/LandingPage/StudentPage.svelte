<script>
  import { pb } from '../../lib/Pocketbase.svelte'
  import { toast } from 'svelte-sonner'

  let {
    studentsCollection = 'student',
    studentNameField = 'englishName',
    graduatedFilter = 'status != "graduated"',
  } = $props()

  function todayISO() {
    return new Date().toISOString().slice(0, 10)
  }

  // --- search bar state ---
  let studentQuery = $state('')
  let selectedStudent = $state(null) // { id, name }
  let suggestions = $state([])
  let showSuggestions = $state(false)
  let searchingStudents = $state(false)

  let selectedDate = $state(todayISO())

  // --- results state ---
  let entries = $state([])
  let loading = $state(false)
  let hasSearched = $state(false)

  let debounceHandle
  $effect(() => {
    const q = studentQuery.trim()
    clearTimeout(debounceHandle)

    if (selectedStudent && selectedStudent[studentNameField] === q) return

    if (q.length < 2) {
      // don't wipe an already-open "show all" list from a focus click
      return
    }

    debounceHandle = setTimeout(() => fetchSuggestions(q), 250)
    return () => clearTimeout(debounceHandle)
  })

  async function fetchSuggestions(q) {
    searchingStudents = true
    try {
      const list = await pb.collection(studentsCollection).getList(1, 6, {
        filter: pb.filter(`${studentNameField} ~ {:q} && ${graduatedFilter}`, { q }),
      })
      suggestions = list.items
      showSuggestions = true
    } catch (e) {
      suggestions = []
    } finally {
      searchingStudents = false
    }
  }

  // shows a batch of students when the box is focused empty, before any typing
  async function fetchAllStudents() {
    searchingStudents = true
    try {
      const list = await pb.collection(studentsCollection).getList(1, 30, {
        sort: studentNameField,
        filter: graduatedFilter,
      })
      suggestions = list.items
      showSuggestions = true
    } catch (e) {
      suggestions = []
    } finally {
      searchingStudents = false
    }
  }

  function pickStudent(s) {
    selectedStudent = s
    studentQuery = s[studentNameField] ?? s.id
    showSuggestions = false
    suggestions = []
  }

  // tries to resolve a typed name to one student without requiring a click:
  // exact (case-insensitive) match wins if there is one, otherwise falls
  // back to whatever partial matches exist so the caller can disambiguate
  async function resolveStudent(query) {
    const list = await pb.collection(studentsCollection).getList(1, 10, {
      filter: pb.filter(`${studentNameField} ~ {:q} && ${graduatedFilter}`, { q: query }),
    })
    const qNorm = query.trim().toLowerCase()
    const exact = list.items.filter((s) => (s[studentNameField] || '').trim().toLowerCase() === qNorm)
    return exact.length ? exact : list.items
  }

  function timeslotLabel(ts) {
    if (!ts) return '—'
    return `${ts.start ?? '?'}–${ts.end ?? '?'}`
  }

  function timeToMinutes(t) {
    const m = /(\d{1,2}):(\d{2})/.exec(String(t ?? ''))
    if (!m) return Number.MAX_SAFE_INTEGER
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
  }

  async function runSearch(e) {
    e?.preventDefault()

    if (!selectedStudent) {
      const q = studentQuery.trim()
      if (!q) {
        toast.error('Type a student name.')
        return
      }

      try {
        const matches = await resolveStudent(q)
        if (matches.length === 1) {
          selectedStudent = matches[0]
        } else if (matches.length > 1) {
          toast.info('A few students match that — pick one below.')
          suggestions = matches
          showSuggestions = true
          return
        } else {
          toast.error('No student found with that name.')
          return
        }
      } catch (e) {
        toast.error('Could not look up that student.')
        return
      }
    }

    loading = true
    hasSearched = true

    try {
      const dayStart = `${selectedDate} 00:00:00`
      const dayEnd = `${selectedDate} 23:59:59`

      const records = await pb.collection('dailySchedule').getFullList({
        filter: pb.filter('student = {:sid} && date >= {:start} && date <= {:end}', {
          sid: selectedStudent.id,
          start: dayStart,
          end: dayEnd,
        }),
        expand: 'room,timeslot,teacher,sub,subject',
      })

      // date only stores the day, not the period, so order by the
      // expanded timeslot's start time instead of the raw sort field
      entries = records
        .slice()
        .sort((a, b) => timeToMinutes(a.expand?.timeslot?.start) - timeToMinutes(b.expand?.timeslot?.start))
    } catch (e) {
      toast.error('Could not load the schedule. Check the connection and try again.')
      entries = []
    } finally {
      loading = false
    }
  }

  let formattedDate = $derived(
    new Date(`${selectedDate}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  )
</script>

<div class="max-w-xl mx-auto p-6 space-y-6">
  <div class="text-center space-y-1">
    <h1 class="text-2xl font-bold">STUDENT SCHEDULE</h1>
    <p class="text-base-content/70">{formattedDate}</p>
  </div>

  <form onsubmit={runSearch} class="flex flex-col sm:flex-row gap-2">
    <div class="dropdown w-full" class:dropdown-open={showSuggestions && suggestions.length}>
      <input
        type="text"
        placeholder="Student name…"
        class="input input-bordered w-full"
        bind:value={studentQuery}
        oninput={() => {
          selectedStudent = null
          if (studentQuery.trim() === '') {
            entries = []
            hasSearched = false
          }
        }}
        onfocus={() => {
          if (studentQuery.trim().length === 0) {
            fetchAllStudents()
          } else if (suggestions.length) {
            showSuggestions = true
          }
        }}
        onblur={() => setTimeout(() => (showSuggestions = false), 120)}
      />
      {#if showSuggestions && suggestions.length}
        <ul
          class="dropdown-content menu bg-base-100 rounded-box shadow-md w-full z-10 max-h-64 overflow-y-auto flex-nowrap"
        >
          {#each suggestions as s (s.id)}
            <li>
              <button type="button" onclick={() => pickStudent(s)}>
                {s[studentNameField] ?? s.id}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <button type="submit" class="btn btn-primary" disabled={loading}>
      {#if loading}<span class="loading loading-spinner loading-sm"></span>{/if}
      Search
    </button>
  </form>

  {#if !hasSearched && !loading}
    <div class="flex justify-center py-12 text-base-content/15">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="300"
        height="300"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="lucide lucide-user-search"
        ><circle cx="10" cy="7" r="4" /><path d="M10.3 15H7a4 4 0 0 0-4 4v2" /><circle cx="17" cy="17" r="3" /><path
          d="m21 21-1.9-1.9"
        /></svg
      >
    </div>
  {/if}

  {#if hasSearched && !loading}
    <div class="space-y-4">
      {#if selectedStudent}
        <div class="rounded-box bg-base-200 p-4 space-y-1">
          <p><span class="font-semibold">Student Name:</span> {selectedStudent[studentNameField] ?? '—'}</p>
          <p><span class="font-semibold">Course:</span> {selectedStudent.course || '—'}</p>
          <p><span class="font-semibold">Level:</span> {selectedStudent.level || '—'}</p>
        </div>
      {/if}

      {#if entries.length === 0}
        <p class="text-base-content/60">No classes on the schedule for this day.</p>
      {:else}
        <ul class="list bg-base-100 rounded-box shadow-md">
          {#each entries as entry (entry.id)}
            <li class="list-row flex flex-col items-start gap-1">
              <span class="text-xs text-base-content/60">{timeslotLabel(entry.expand?.timeslot)}</span>
              <span class="font-semibold">{entry.expand?.subject?.name ?? '—'}</span>
              <span class="text-sm text-base-content/70">
                Taught by {entry.expand?.teacher?.name ?? '—'} in Room {entry.expand?.room?.name ?? '—'}
              </span>
              {#if entry.expand?.sub}
                <span class="badge badge-warning badge-sm">
                  Covered by {entry.expand.sub.name ?? entry.expand.sub.id}
                </span>
              {/if}
              {#if entry.status && entry.status !== 'show'}
                <span class="badge badge-ghost badge-sm">{entry.status}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
