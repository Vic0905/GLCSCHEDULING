<script>
  import { onMount } from 'svelte'
  import { Grid, h } from 'gridjs'
  import { toast } from 'svelte-sonner'
  import Papa from 'papaparse'
  import { pb } from '../../../../../lib/Pocketbase.svelte'

  // ── Constants ─────────────────────────────────────────────────────────────
  const STATUS_OPTIONS = ['enabled', 'disabled']
  const STATUS_BADGE = { enabled: 'badge-success', disabled: 'badge-error' }

  // ── State ─────────────────────────────────────────────────────────────────
  let teachers = $state([])
  let showModal = $state(false)
  let gridElement = $state(null)
  let gridInstance = null
  let isProcessing = $state(false)
  let selectedTeachers = $state(new Set())

  let formData = $state({ id: null, name: '', status: 'enabled' })

  // ── Derived ───────────────────────────────────────────────────────────────
  let stats = $derived({
    total: teachers.length,
    enabled: teachers.filter((t) => t.status === 'enabled').length,
    disabled: teachers.filter((t) => t.status === 'disabled').length,
  })

  // ── Helpers ───────────────────────────────────────────────────────────────
  async function batchFetch(requests) {
    // CHANGED: strip any trailing slash from pb.baseUrl before concatenating.
    // pb.baseUrl already ends in "/", so appending "/api/batch" produced a
    // double slash ("...online//api/batch"). The server normalizes that with
    // a redirect, and browsers refuse to follow a redirect on a CORS
    // preflight (OPTIONS) request — that's what was causing the CORS error.
    const base = pb.baseUrl.replace(/\/+$/, '')
    const res = await fetch(`${base}/api/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pb.authStore.token}`,
      },
      body: JSON.stringify({ requests }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(text)
    return JSON.parse(text)
  }

  async function batchFetchChunked(requests, chunkSize = 50) {
    const allResults = []
    for (let i = 0; i < requests.length; i += chunkSize) {
      const chunk = requests.slice(i, i + chunkSize)
      const res = await batchFetch(chunk)
      allResults.push(...res)
    }
    return allResults
  }

  // ── User account helper ────────────────────────────────────────────────────
  async function createTeacherUser(name) {
    const trimmedName = name.trim()

    try {
      const existing = await pb.collection('users').getFirstListItem(`firstName="${trimmedName}"`)
      return existing.id
    } catch {
      // not found, continue to create
    }

    const base = trimmedName.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!base) return null
    let username = base
    let suffix = 1
    while (true) {
      try {
        await pb.collection('users').getFirstListItem(`username="${username}"`)
        username = `${base}${suffix++}`
      } catch {
        break
      }
    }

    try {
      const user = await pb.collection('users').create({
        username,
        email: `${username}@teacher.local`,
        emailVisibility: true,
        password: '00000000',
        passwordConfirm: '00000000',
        firstName: trimmedName,
        role: 'teacher',
      })
      return user.id
    } catch (err) {
      console.error('Failed to create user for', name, err)
      toast.error(`User creation failed: ${err?.response?.message || err.message}`)
      return null
    }
  }

  // ── Grid ──────────────────────────────────────────────────────────────────
  function buildRows(records) {
    return records.map((t) => [
      h('input', {
        type: 'checkbox',
        className: 'checkbox checkbox-sm checkbox-neutral',
        checked: selectedTeachers.has(t.id),
        onChange: (e) => toggleSelection(t.id, e.target.checked),
      }),
      t.name,
      h('span', { className: `badge badge-sm ${STATUS_BADGE[t.status] ?? 'badge-neutral'}` }, t.status ?? 'enabled'),
      h('div', { className: 'flex gap-2 justify-center' }, [
        h('button', { className: 'btn btn-xs btn-outline btn-info', onclick: () => openEdit(t) }, 'Edit'),
        h('button', { className: 'btn btn-xs btn-outline btn-error', onclick: () => deleteTeacher(t.id) }, 'Delete'),
      ]),
    ])
  }

  function renderGrid(records) {
    if (!gridElement) return
    const data = buildRows(records)

    if (gridInstance) {
      gridInstance.updateConfig({ data }).forceRender()
    } else {
      gridInstance = new Grid({
        columns: [
          { name: 'Select', width: '80px', sort: false },
          { name: 'Name', width: '150px' },
          { name: 'Status', width: '100px' },
          { name: 'Actions', width: '130px', sort: false },
        ],
        data,
        search: true,
        pagination: { limit: 10 },
        className: {
          table: 'table w-full',
          th: 'text-center',
          td: 'text-center',
          search: 'input input-sm m-5',
          pagination: 'flex flex-row justify-between mt-5',
          paginationButton: 'btn btn-sm',
        },
      }).render(gridElement)
    }
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  async function loadTeachers() {
    try {
      teachers = await pb.collection('teacher').getFullList({ sort: '-created' })
      renderGrid(teachers)
    } catch {
      toast.error('Failed to load teachers')
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────
  async function saveTeacher() {
    const trimmed = formData.name.trim()
    if (!trimmed) return toast.error('Name is required')

    const dupe = teachers.some((t) => t.name.toLowerCase() === trimmed.toLowerCase() && t.id !== formData.id)
    if (dupe) return toast.error(`"${trimmed}" already exists`)

    isProcessing = true
    try {
      const payload = { name: trimmed, status: formData.status }
      if (formData.id) {
        await pb.collection('teacher').update(formData.id, payload)

        const original = teachers.find((t) => t.id === formData.id)
        if (original?.user && original.name?.toLowerCase() !== trimmed.toLowerCase()) {
          const newBase = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '')
          if (newBase) {
            try {
              await pb.collection('users').update(original.user, {
                firstName: trimmed,
                username: newBase,
              })
            } catch (userErr) {
              console.warn('Could not sync username:', userErr)
              toast.warning('Teacher updated but username sync failed — username may already be taken')
            }
          }
        }

        toast.success('Teacher updated')
      } else {
        const newTeacher = await pb.collection('teacher').create(payload)
        const userId = await createTeacherUser(trimmed)
        if (userId) await pb.collection('teacher').update(newTeacher.id, { user: userId })
        toast.success('Teacher added')
      }
      closeModal()
      await loadTeachers()
    } catch (err) {
      toast.error(err?.status === 400 ? 'Name already in use' : 'Unexpected error')
    } finally {
      isProcessing = false
    }
  }

  async function deleteTeacher(id) {
    if (!confirm('Delete this teacher?')) return
    try {
      const teacher = await pb.collection('teacher').getOne(id)
      await pb.collection('teacher').delete(id)
      if (teacher.user) await pb.collection('users').delete(teacher.user)
      toast.success('Teacher deleted')
      await loadTeachers()
    } catch {
      toast.error('Delete failed')
    }
  }

  // ── Bulk selection ────────────────────────────────────────────────────────
  function toggleSelection(id, checked) {
    const next = new Set(selectedTeachers)
    checked ? next.add(id) : next.delete(id)
    selectedTeachers = next
  }

  async function selectAll() {
    selectedTeachers = new Set(teachers.map((t) => t.id))
    renderGrid(teachers)
  }

  async function clearSelection() {
    selectedTeachers = new Set()
    renderGrid(teachers)
  }

  async function bulkUpdateStatus(newStatus) {
    if (!selectedTeachers.size) return toast.error('No teachers selected')
    const label = newStatus === 'enabled' ? 'Enabled' : 'Disabled'
    if (!confirm(`Mark ${selectedTeachers.size} teacher(s) as ${label}?`)) return

    isProcessing = true
    let ok = 0,
      fail = 0
    for (const id of selectedTeachers) {
      try {
        await pb.collection('teacher').update(id, { status: newStatus })
        ok++
      } catch {
        fail++
      }
    }
    toast.success(`${ok} updated${fail ? `, ${fail} failed` : ''}`)
    selectedTeachers = new Set()
    isProcessing = false
    await loadTeachers()
  }

  async function bulkDeleteTeachers() {
    if (!selectedTeachers.size) return toast.error('No teachers selected')
    if (!confirm(`Delete ${selectedTeachers.size} teacher(s)?`)) return
    isProcessing = true
    try {
      const records = await pb.collection('teacher').getFullList({
        filter: Array.from(selectedTeachers)
          .map((id) => `id="${id}"`)
          .join(' || '),
      })
      await Promise.all(records.map((t) => pb.collection('teacher').delete(t.id)))
      await Promise.all(records.filter((t) => t.user).map((t) => pb.collection('users').delete(t.user)))
      toast.success(`${records.length} teacher(s) deleted`)
      selectedTeachers = new Set()
      await loadTeachers()
    } catch {
      toast.error('Bulk delete failed')
    } finally {
      isProcessing = false
    }
  }

  // ── CSV ───────────────────────────────────────────────────────────────────
  function downloadTemplate() {
    const csv = Papa.unparse({
      fields: ['Name', 'Status'],
      data: [],
    })
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'teachers_template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  function triggerCSVImport() {
    document.getElementById('csv-import-input').click()
  }

  async function handleCSVImport(e) {
    const file = e.target.files?.[0]
    if (!file) return

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (result) => {
        const rows = result.data
          .map((row) => {
            const normalized = {}
            for (const key in row) {
              normalized[key.trim().toLowerCase()] = row[key]
            }
            return {
              name: (normalized['name'] || '').trim(),
              status: (normalized['status'] || 'enabled').trim(),
            }
          })
          .filter((r) => r.name)

        if (!rows.length) return toast.error('No valid rows found in CSV')

        const existingNames = new Set(teachers.map((t) => t.name?.toLowerCase()))
        const toCreate = rows.filter((r) => !existingNames.has(r.name.toLowerCase()))
        const skipped = rows.length - toCreate.length

        if (!toCreate.length) {
          toast.error(`All ${skipped} row(s) already exist`)
          e.target.value = ''
          return
        }

        isProcessing = true
        try {
          const results = await batchFetchChunked(
            toCreate.map((row) => ({
              method: 'POST',
              url: '/api/collections/teacher/records',
              body: row,
            }))
          )
          const added = results.filter((r) => r.status >= 200 && r.status < 300).length
          const failed = results.filter((r) => r.status < 200 || r.status >= 300).length

          const successful = toCreate
            .map((row, i) => ({ row, result: results[i] }))
            .filter(({ result }) => result.status >= 200 && result.status < 300)

          await Promise.allSettled(
            successful.map(async ({ row, result }) => {
              const userId = await createTeacherUser(row.name)
              if (userId) await pb.collection('teacher').update(result.body.id, { user: userId })
            })
          )

          toast.success(
            [added && `${added} imported`, skipped && `${skipped} skipped`, failed && `${failed} failed`]
              .filter(Boolean)
              .join(', ')
          )
          await loadTeachers()
        } catch {
          toast.error('CSV import failed')
        } finally {
          isProcessing = false
          e.target.value = ''
        }
      },
      error: () => toast.error('Failed to parse CSV'),
    })
  }

  // ── Modal helpers ─────────────────────────────────────────────────────────
  function openAdd() {
    formData = { id: null, name: '', status: 'enabled' }
    showModal = true
  }

  function openEdit(teacher) {
    formData = { id: teacher.id, name: teacher.name, status: teacher.status ?? 'enabled' }
    showModal = true
  }

  function closeModal() {
    showModal = false
    formData = { id: null, name: '', status: 'enabled' }
  }

  // ── Cleanup on destroy ────────────────────────────────────────────────────
  $effect(() => {
    return () => {
      if (gridInstance && gridElement) {
        gridElement.innerHTML = ''
        gridInstance = null
      }
    }
  })

  onMount(loadTeachers)
</script>

<main class="p-8 max-w-[90rem] mx-auto space-y-6">
  <!-- Header -->
  <header class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-6">
    <div>
      <h1 class="text-3xl font-extrabold tracking-tight text-base-content">Teacher Information</h1>
      <div class="flex gap-4 mt-2 text-sm text-base-content/60">
        <span>Total <strong class="text-base-content">{stats.total}</strong></span>
        <span>Enabled <strong class="text-success">{stats.enabled}</strong></span>
        <span>Disabled <strong class="text-error">{stats.disabled}</strong></span>
      </div>
    </div>
    <div class="flex gap-2">
      <input id="csv-import-input" type="file" accept=".csv" class="hidden" onchange={handleCSVImport} />
      <button class="btn btn-outline shadow-sm" onclick={downloadTemplate}>Download Template</button>
      <button class="btn btn-outline shadow-sm" onclick={triggerCSVImport} disabled={isProcessing}>Import CSV</button>
      <button class="btn btn-outline btn-primary shadow-sm" onclick={openAdd}>Add Teacher</button>
    </div>
  </header>

  <!-- Bulk action bar -->
  {#if selectedTeachers.size > 0}
    <div class="card bg-base-100 border border-base-200 px-5 py-3">
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <p class="text-sm font-medium">
          <strong>{selectedTeachers.size}</strong> teacher{selectedTeachers.size > 1 ? 's' : ''} selected
        </p>
        <div class="flex flex-wrap gap-2">
          <button class="btn btn-xs btn-ghost" onclick={selectAll}>Select All</button>
          <button class="btn btn-xs btn-ghost" onclick={clearSelection}>Clear</button>
          <div class="divider divider-horizontal my-0 mx-1"></div>
          <button
            class="btn btn-xs btn-outline btn-success"
            onclick={() => bulkUpdateStatus('enabled')}
            disabled={isProcessing}>Enable</button
          >
          <button
            class="btn btn-xs btn-outline btn-error"
            onclick={() => bulkUpdateStatus('disabled')}
            disabled={isProcessing}
          >
            {isProcessing ? 'Processing…' : 'Disable'}
          </button>

          <div class="divider divider-horizontal my-0 mx-1"></div>
          <button class="btn btn-xs btn-error" onclick={bulkDeleteTeachers} disabled={isProcessing}>
            {isProcessing ? 'Processing…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Grid -->
  <section class="card bg-base-100 border border-base-200">
    <div class="card-body p-0">
      <div bind:this={gridElement}></div>
    </div>
  </section>
</main>

<!-- Add / Edit Modal -->
{#if showModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div class="modal modal-open bg-black/40" role="dialog" onclick={(e) => e.target === e.currentTarget && closeModal()}>
    <div class="modal-box max-w-md border border-base-300 p-6">
      <div class="flex justify-between items-center mb-6">
        <h3 class="font-bold text-xl text-base-content">{formData.id ? 'Update' : 'Add'} Teacher</h3>
        <button class="btn btn-sm btn-circle btn-ghost" onclick={closeModal}>✕</button>
      </div>

      <div class="flex flex-col gap-5">
        <div class="form-control w-full">
          <label class="label py-1" for="teacher-name">
            <span class="label-text font-semibold text-base-content">
              Name <span class="opacity-40 font-normal text-xs">(required)</span>
            </span>
          </label>
          <input
            id="teacher-name"
            bind:value={formData.name}
            type="text"
            class="input input-bordered w-full focus:input-primary"
            placeholder="Enter teacher name"
            onkeydown={(e) => e.key === 'Enter' && saveTeacher()}
          />
        </div>

        <div class="form-control w-full">
          <label class="label py-1" for="teacher-status">
            <span class="label-text font-semibold text-base-content">Status</span>
          </label>
          <select
            id="teacher-status"
            bind:value={formData.status}
            class="select select-bordered w-full focus:select-primary"
          >
            {#each STATUS_OPTIONS as opt}
              <option value={opt}>{opt.charAt(0).toUpperCase() + opt.slice(1)}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="modal-action mt-8 gap-2">
        <button class="btn btn-ghost px-6" onclick={closeModal} disabled={isProcessing}>Cancel</button>
        <button class="btn btn-primary px-6 shadow-sm" onclick={saveTeacher} disabled={isProcessing}>
          {#if isProcessing}
            <span class="loading loading-spinner loading-sm"></span>
          {:else}
            {formData.id ? 'Save Changes' : 'Add Teacher'}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  :global(html) {
    scrollbar-gutter: stable;
  }
  :global(.gridjs-container) {
    border-radius: 0.75rem;
    overflow: hidden;
  }
  :global(.gridjs-search-input) {
    border-radius: 0.5rem !important;
  }
</style>
