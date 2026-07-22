<script>
  import { onMount } from 'svelte'
  import { pb } from '../../../../../lib/Pocketbase.svelte'

  // ─────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────
  let logs = $state([])
  let isLoading = $state(false)
  let error = $state('')
  let filterAction = $state('')
  let searchQuery = $state('')

  // Pagination
  let currentPage = $state(1)
  let totalPages = $state(1)
  let totalItems = $state(0)
  const PER_PAGE = 100

  const ACTION_LABELS = {
    add: 'Added',
    update: 'Updated',
    sub: 'Sub assigned',
    sub_edit: 'Sub changed',
    sub_remove: 'Sub removed',
    delete: 'Deleted',
    show: 'Shown',
    draft: 'Drafted',
    copy: 'Copied',
    clear: 'Cleared',
    makeup: 'Make-up class',
    makeup_edit: 'Make-up edited',
    makeup_delete: 'Make-up deleted',
  }

  // ─────────────────────────────────────────────
  // DERIVED
  // ─────────────────────────────────────────────
  let filteredLogs = $derived.by(() => {
    if (!searchQuery.trim()) return logs
    const q = searchQuery.trim().toLowerCase()
    return logs.filter((log) => {
      const user = log.expand?.performedBy?.name || log.expand?.performedBy?.username || 'system'
      const details = getDetailFields(log)
        .map((f) => f.value)
        .join(' ')
        .toLowerCase()
      return user.toLowerCase().includes(q) || log.action.includes(q) || details.includes(q)
    })
  })

  // ─────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────
  function formatDateTime(dateStr) {
    if (!dateStr) return '—'
    return new Date(dateStr).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  /** Short "3h ago" style label for the timestamp tooltip. */
  function formatRelative(dateStr) {
    if (!dateStr) return ''
    const diffMs = Date.now() - new Date(dateStr).getTime()
    const minutes = Math.round(diffMs / 60000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.round(hours / 24)
    if (days < 30) return `${days}d ago`
    return formatDateTime(dateStr)
  }

  function getActionColor(action) {
    const colors = {
      add: 'badge-primary badge-soft',
      update: 'badge-info badge-soft',
      delete: 'badge-error badge-soft',
      show: 'badge-success badge-soft',
      draft: 'badge-warning badge-soft',
      copy: 'badge-secondary badge-soft',
      clear: 'badge-error badge-soft',
      sub: 'badge-info badge-soft',
      sub_edit: 'badge-info badge-soft',
      sub_remove: 'badge-error badge-soft',
      makeup: 'badge-accent badge-soft',
      makeup_edit: 'badge-accent badge-soft',
      makeup_delete: 'badge-error badge-soft',
    }
    return colors[action] || 'badge-ghost'
  }

  /**
   * Returns the details for a log entry as an ordered list of
   * { label, value } fields, rendered as compact chips in the table
   * rather than a single pipe-delimited string.
   */
  function getDetailFields(log) {
    if (!log.details) return [{ label: '', value: '—' }]

    const {
      teacherName,
      roomName,
      timeslot,
      students,
      rangeStart,
      rangeEnd,
      roomType,
      count,
      sourceDate,
      date,
      subName,
      subjectName,
    } = log.details

    const studentList = Array.isArray(students) && students.length ? students.map((s) => s.name).join(', ') : 'None'

    const range =
      rangeStart && rangeEnd ? (rangeStart === rangeEnd ? rangeStart : `${rangeStart} → ${rangeEnd}`) : (date ?? '?')

    switch (log.action) {
      case 'sub':
      case 'sub_edit':
      case 'sub_remove':
        return [
          { label: 'Date', value: range },
          { label: 'Timeslot', value: timeslot || '?' },
          { label: 'Room', value: roomName || '?' },
          { label: 'Teacher', value: teacherName || '?' },
          { label: 'Sub', value: subName || 'Removed' },
        ]
      case 'show':
      case 'draft':
      case 'clear':
        return [
          { label: 'Date', value: range },
          { label: 'Room type', value: roomType || 'All' },
          { label: 'Count', value: count ?? '?' },
        ]
      case 'copy': {
        const target =
          rangeStart && rangeEnd ? (rangeStart === rangeEnd ? rangeStart : `${rangeStart} → ${rangeEnd}`) : '?'
        return [
          { label: 'From', value: sourceDate || '?' },
          { label: 'To', value: target },
          { label: 'Room type', value: roomType || 'All' },
          { label: 'Count', value: count ?? '?' },
        ]
      }
      case 'delete':
        return [
          { label: 'Date', value: date ?? sourceDate ?? '?' },
          { label: 'Timeslot', value: timeslot || '?' },
          { label: 'Room', value: roomName || '?' },
          { label: 'Teacher', value: teacherName || '?' },
          { label: 'Students', value: studentList },
        ]
      case 'makeup':
      case 'makeup_edit':
      case 'makeup_delete':
        return [
          { label: 'Date', value: range },
          { label: 'Timeslot', value: timeslot || '?' },
          { label: 'Room', value: roomName || '?' },
          { label: 'Teacher', value: teacherName || '?' },
          { label: 'Subject', value: subjectName || '?' },
          { label: 'Students', value: studentList },
        ]
      default:
        if (log.details.type === 'skip_day') {
          return [
            { label: 'Student', value: String(log.details.studentId) },
            { label: 'Skipped on', value: log.details.skippedDate },
          ]
        }
        // add / update
        return [
          { label: 'Date', value: range },
          { label: 'Timeslot', value: timeslot || '?' },
          { label: 'Room', value: roomName || '?' },
          { label: 'Teacher', value: teacherName || '?' },
          { label: 'Students', value: studentList },
        ]
    }
  }

  // ─────────────────────────────────────────────
  // DATA FETCHING
  // ─────────────────────────────────────────────
  async function fetchLogs(page = 1) {
    isLoading = true
    error = ''
    try {
      const filter = filterAction ? `action = "${filterAction}"` : ''

      const result = await pb.collection('activityLog').getList(page, PER_PAGE, {
        ...(filter ? { filter } : {}),
        sort: '-created',
        expand: 'performedBy',
      })

      logs = result.items
      currentPage = result.page
      totalPages = result.totalPages
      totalItems = result.totalItems
    } catch (err) {
      console.error('Failed to fetch activity logs:', err)
      error = 'Something went wrong loading the activity log. Please try again.'
      logs = []
      totalPages = 1
      totalItems = 0
    } finally {
      isLoading = false
    }
  }

  function goToPage(page) {
    if (page < 1 || page > totalPages || page === currentPage) return
    fetchLogs(page)
  }

  // Reset to page 1 when filter changes
  $effect(() => {
    filterAction
    fetchLogs(1)
  })

  onMount(() => fetchLogs(1))
</script>

<div class="p-2 sm:p-4 md:p-6 bg-base-100 min-h-screen">
  <!-- Header -->
  <div class="flex flex-col gap-1 mb-6 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
    <div class="flex items-center gap-2.5">
      <span class="flex items-center justify-center w-9 h-9 rounded-lg bg-neutral text-neutral-content shrink-0">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.75"
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </span>
      <div>
        <h2 class="text-xl font-semibold leading-tight">Activity Log</h2>
        <p class="text-xs text-base-content/50">
          {totalItems > 0 ? `${totalItems} recorded event${totalItems === 1 ? '' : 's'}` : 'System activity history'}
        </p>
      </div>
    </div>

    <div class="flex items-center gap-2.5">
      <label class="sr-only" for="activity-search">Search activity log</label>
      <input
        id="activity-search"
        type="text"
        placeholder="Search user, action, or details…"
        bind:value={searchQuery}
        class="input input-bordered input-sm w-full sm:w-56"
      />

      <label class="sr-only" for="activity-filter">Filter by action</label>
      <select id="activity-filter" class="select select-bordered select-sm" bind:value={filterAction}>
        <option value="">All actions</option>
        <option value="add">Added</option>
        <option value="update">Updated</option>
        <option value="sub">Sub assigned</option>
        <option value="sub_edit">Sub changed</option>
        <option value="sub_remove">Sub removed</option>
        <option value="delete">Deleted</option>
        <option value="makeup">Make-up class</option>
        <option value="makeup_edit">Make-up edited</option>
        <option value="makeup_delete">Make-up deleted</option>
      </select>

      <button
        type="button"
        class="btn btn-sm btn-ghost btn-square"
        onclick={() => fetchLogs(currentPage)}
        disabled={isLoading}
        aria-label="Refresh"
        title="Refresh"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="w-4 h-4 {isLoading ? 'animate-spin' : ''}"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.75"
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
      </button>
    </div>
  </div>

  {#if error}
    <div class="alert alert-error alert-soft mb-4 text-sm">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="w-5 h-5 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.75"
          d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
        />
      </svg>
      <span>{error}</span>
      <button type="button" class="btn btn-xs btn-outline" onclick={() => fetchLogs(currentPage)}>Try again</button>
    </div>
  {/if}

  {#if isLoading && logs.length === 0 && !error}
    <div class="flex justify-center py-16">
      <span class="loading loading-spinner loading-lg text-base-content/40"></span>
    </div>
  {:else if !error && filteredLogs.length === 0}
    <div class="flex flex-col items-center justify-center py-16 text-base-content/30 gap-2">
      <svg xmlns="http://www.w3.org/2000/svg" class="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.5"
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
      <p class="text-sm">
        {searchQuery.trim() || filterAction
          ? 'No activity matches your search or filter.'
          : 'No activity has been recorded yet.'}
      </p>
    </div>
  {:else if !error}
    <div class="rounded-lg border border-base-300">
      <!-- Scrollable, fixed-height table area -->
      <div class="overflow-auto" style="height: clamp(320px, 65dvh, 900px);">
        <table class="table table-zebra w-full text-sm">
          <thead class="sticky top-0 z-10">
            <tr class="bg-neutral text-neutral-content">
              <th class="text-center w-12">#</th>
              <th>User</th>
              <th>Action</th>
              <th>Date &amp; time</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody class={isLoading ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
            {#each filteredLogs as log, i (log.id)}
              <tr class="hover:bg-base-200/60">
                <td class="text-center text-base-content/90 font-mono text-xs">
                  {totalItems - (currentPage - 1) * PER_PAGE - i}
                </td>
                <td>
                  <span class="font-medium">
                    {log.expand?.performedBy?.name || log.expand?.performedBy?.username || 'System'}
                  </span>
                </td>
                <td>
                  <span class="badge badge-sm {getActionColor(log.action)} font-bold text-xs">
                    {ACTION_LABELS[log.action] || log.action}
                  </span>
                </td>
                <td class="tabular-nums text-base-content/80 whitespace-nowrap" title={formatDateTime(log.created)}>
                  {formatRelative(log.created)}
                </td>
                <td class="text-base-content/90 font-bold">
                  <div class="flex flex-col gap-0.5">
                    {#each getDetailFields(log) as field}
                      <div class="flex gap-1">
                        {#if field.label}<span class="text-base-content/90">{field.label}:</span>{/if}
                        <span>{field.value}</span>
                      </div>
                    {/each}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <!-- Pagination footer — now outside the scroll container -->
      <div
        class="flex flex-col gap-3 px-4 py-3 border-t border-base-300 text-sm text-base-content/60 sm:flex-row sm:items-center sm:justify-between"
      >
        <span>
          {#if totalItems > 0}
            Showing {(currentPage - 1) * PER_PAGE + 1}–{Math.min(currentPage * PER_PAGE, totalItems)} of {totalItems}
          {:else}
            No results
          {/if}
        </span>

        <div class="join self-start sm:self-auto" role="navigation" aria-label="Pagination">
          <button
            class="join-item btn btn-sm"
            onclick={() => goToPage(1)}
            disabled={currentPage === 1}
            aria-label="First page">«</button
          >
          <button
            class="join-item btn btn-sm"
            onclick={() => goToPage(currentPage - 1)}
            disabled={currentPage === 1}
            aria-label="Previous page">‹</button
          >

          {#each Array.from({ length: totalPages }, (_, i) => i + 1) as page}
            {#if totalPages <= 7 || page === 1 || page === totalPages || Math.abs(page - currentPage) <= 1}
              <button
                class="join-item btn btn-sm {page === currentPage ? 'btn-neutral' : ''}"
                onclick={() => goToPage(page)}
                aria-current={page === currentPage ? 'page' : undefined}
              >
                {page}
              </button>
            {:else if Math.abs(page - currentPage) === 2}
              <button class="join-item btn btn-sm btn-disabled">…</button>
            {/if}
          {/each}

          <button
            class="join-item btn btn-sm"
            onclick={() => goToPage(currentPage + 1)}
            disabled={currentPage === totalPages}
            aria-label="Next page">›</button
          >
          <button
            class="join-item btn btn-sm"
            onclick={() => goToPage(totalPages)}
            disabled={currentPage === totalPages}
            aria-label="Last page">»</button
          >
        </div>
      </div>
    </div>
  {/if}
</div>
