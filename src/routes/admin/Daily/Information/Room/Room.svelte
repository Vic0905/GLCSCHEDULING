<script>
  import { onMount } from 'svelte'
  import { Grid, h } from 'gridjs'
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../../lib/Pocketbase.svelte'

  // --- State Management ---
  let rooms = $state([])
  let allTeachers = $state([])
  let showModal = $state(false)
  let gridElement = $state(null)
  let gridInstance = null

  let formData = $state({
    id: null,
    name: '',
    roomType: 'mtm',
    maxStudents: 0,
    selectedTeacherId: '',
    status: 'enabled',
  })

  // --- Derived State (The Magic) ---
  // Filters out teachers that are disabled OR assigned to another enabled room
  let availableTeachers = $derived(
    allTeachers.filter((t) => {
      if (t.status === 'disabled') return false
      // Is this teacher assigned to an enabled room that is NOT the one we are currently editing?
      const isAssigned = rooms.some((r) => r.status === 'enabled' && r.teacher === t.id && r.id !== formData.id)
      return !isAssigned
    })
  )

  // --- Effects ---
  $effect(() => {
    if (formData.roomType === 'mtm') formData.maxStudents = 1
  })

  $effect(() => {
    if (formData.status === 'disabled') formData.selectedTeacherId = ''
  })

  // --- Logic ---
  async function loadInitialData() {
    try {
      const [teacherList, roomList] = await Promise.all([
        pb.collection('teacher').getFullList({ sort: 'name' }),
        pb.collection('roomType').getFullList({ expand: 'teacher' }),
      ])

      allTeachers = teacherList
      rooms = roomList.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    } catch (err) {
      toast.error('Failed to load data')
    }
  }

  async function saveRoom() {
    if (!formData.name.trim()) return toast.error('Room name is required')

    const payload = {
      name: formData.name.trim(),
      roomType: formData.roomType,
      maxStudents: formData.maxStudents,
      status: formData.status,
      teacher: formData.status === 'disabled' ? null : formData.selectedTeacherId || null,
    }

    try {
      if (formData.id) {
        await pb.collection('roomType').update(formData.id, payload)
      } else {
        await pb.collection('roomType').create(payload)
      }

      toast.success('Room saved successfully')
      closeModal()
      await loadInitialData()
    } catch (err) {
      // 400 error caught here when PocketBase Unique Index fails
      if (err.status === 400) {
        toast.error('Save failed: A room with this Name, Type, and Status already exists.')
      } else {
        toast.error('An unexpected error occurred.')
      }
    }
  }

  function openEdit(room) {
    formData = {
      id: room.id,
      name: room.name,
      roomType: room.roomType,
      maxStudents: room.maxStudents,
      selectedTeacherId: room.teacher || '',
      status: room.status || 'enabled',
    }
    showModal = true
  }

  function closeModal() {
    showModal = false
    formData = { id: null, name: '', roomType: 'mtm', maxStudents: 0, selectedTeacherId: '', status: 'enabled' }
  }

  async function deleteRoom(id) {
    if (confirm('Are you sure you want to delete this room?')) {
      try {
        await pb.collection('roomType').delete(id)
        toast.success('Deleted')
        await loadInitialData()
      } catch (err) {
        toast.error('Delete failed')
      }
    }
  }

  // Grid Initialization
  $effect(() => {
    if (gridElement && !gridInstance) {
      gridInstance = new Grid({
        columns: ['Room Name', 'Type', 'Capacity', 'Teacher', 'Status', { name: 'Actions', sort: false }],
        data: [],
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

    return () => {
      if (gridInstance) {
        gridElement.innerHTML = ''
        gridInstance = null
      }
    }
  })

  // Grid Data Updates
  $effect(() => {
    if (gridInstance && rooms.length >= 0) {
      const data = rooms.map((r) => {
        const assignedTeacher = r.expand?.teacher
        const teacherName = assignedTeacher
          ? assignedTeacher.status === 'disabled'
            ? `${assignedTeacher.name} (Disabled)`
            : assignedTeacher.name
          : 'Unassigned'

        const statusBadge =
          r.status === 'disabled'
            ? h('span', { className: 'badge badge-error badge-sm' }, 'Disabled')
            : h('span', { className: 'badge badge-success badge-sm' }, 'Enabled')

        return [
          r.name,
          r.roomType?.toUpperCase(),
          r.maxStudents,
          teacherName,
          statusBadge,
          h('div', { className: 'flex gap-2 justify-center' }, [
            h('button', { className: 'btn btn-xs btn-outline btn-info', onclick: () => openEdit(r) }, 'Edit'),
            h('button', { className: 'btn btn-xs btn-outline btn-error', onclick: () => deleteRoom(r.id) }, 'Delete'),
          ]),
        ]
      })

      gridInstance.updateConfig({ data }).forceRender()
    }
  })

  onMount(loadInitialData)
</script>

<main class="p-8 max-w-[90rem] mx-auto space-y-6">
  <header class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-6">
    <div>
      <h1 class="text-3xl font-extrabold tracking-tight text-base-content">Room Information</h1>
    </div>
    <div class="flex items-center gap-4">
      <button class="btn btn-outline btn-primary shadow-sm" onclick={() => (showModal = true)}> Add Room </button>
    </div>
  </header>

  <section class="card bg-base-100 border border-base-200">
    <div class="card-body p-0">
      <div bind:this={gridElement}></div>
    </div>
  </section>
</main>

{#if showModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div class="modal modal-open bg-black/40" role="dialog" onclick={(e) => e.target === e.currentTarget && closeModal()}>
    <div class="modal-box max-w-md border border-base-300 p-6">
      <div class="flex justify-between items-center mb-6">
        <h3 class="font-bold text-xl text-base-content">{formData.id ? 'Update' : 'Create'} Room</h3>
        <button class="btn btn-sm btn-circle btn-ghost" onclick={closeModal}>✕</button>
      </div>

      <div class="flex flex-col gap-5">
        <div class="form-control w-full">
          <label class="label py-1" for="room-name">
            <span class="label-text font-semibold text-base-content">Room Name</span>
          </label>
          <input
            id="room-name"
            bind:value={formData.name}
            type="text"
            class="input input-bordered w-full focus:input-primary"
            placeholder="e.g. A101, B202"
          />
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div class="form-control w-full">
            <label class="label py-1" for="room-type">
              <span class="label-text font-semibold text-base-content">Room Type</span>
            </label>
            <select
              id="room-type"
              bind:value={formData.roomType}
              class="select select-bordered w-full focus:select-primary"
            >
              <option value="mtm">1-on-1 (MTM)</option>
              <option value="grp">Group Session</option>
            </select>
          </div>

          <div class="form-control w-full">
            <label class="label py-1" for="capacity">
              <span class="label-text font-semibold text-base-content">Capacity</span>
            </label>
            <input
              id="capacity"
              bind:value={formData.maxStudents}
              type="number"
              min="0"
              disabled={formData.roomType === 'mtm'}
              class="input input-bordered w-full focus:input-primary"
            />
          </div>
        </div>

        <div class="form-control w-full">
          <label class="label py-1" for="room-status">
            <span class="label-text font-semibold text-base-content">Room Status</span>
          </label>
          <select
            id="room-status"
            bind:value={formData.status}
            class="select select-bordered w-full focus:select-primary"
          >
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>

        <div class="form-control w-full">
          <label class="label py-1" for="teacher">
            <span class="label-text font-semibold text-base-content">Assigned Teacher</span>
          </label>
          <select
            id="teacher"
            bind:value={formData.selectedTeacherId}
            class="select select-bordered w-full focus:select-primary"
            disabled={formData.status === 'disabled'}
          >
            <option value="">Unassigned</option>
            <!-- Render the derived availableTeachers directly -->
            {#each availableTeachers as t}
              <option value={t.id}>{t.name}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="modal-action mt-8 gap-2">
        <button class="btn btn-ghost px-6" onclick={closeModal}>Cancel</button>
        <button class="btn btn-primary px-6 shadow-sm" onclick={saveRoom}>
          {formData.id ? 'Save Changes' : 'Create Room'}
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
