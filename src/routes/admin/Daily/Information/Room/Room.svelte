<script>
  import { onMount } from 'svelte'
  import { Grid, h } from 'gridjs'
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../../lib/Pocketbase.svelte'

  // --- State Management (Svelte 5 Runes) ---
  let rooms = $state([])
  let teachers = $state([])
  let showModal = $state(false)
  let gridElement = $state(null)
  let gridInstance = null

  // Form State grouped into one object
  let formData = $state({
    id: null,
    name: '',
    roomType: 'mtm',
    maxStudents: 0,
    selectedTeacherId: '',
    status: 'enabled', // Add status to form data
  })

  $effect(() => {
    if (formData.roomType === 'mtm') {
      formData.maxStudents = 1
    }
  })

  // Watch for status changes to handle teacher removal
  $effect(() => {
    if (formData.status === 'disabled') {
      formData.selectedTeacherId = ''
    }
  })

  // --- Logic ---

  /**
   * Checks whether a given teacher ID belongs to a disabled teacher.
   * Uses the full (unfiltered) teachers list stored in allTeachers.
   */
  let allTeachers = $state([])

  function isTeacherActive(teacherId) {
    if (!teacherId) return false
    const teacher = allTeachers.find((t) => t.id === teacherId)
    return teacher ? teacher.status !== 'disabled' : false
  }

  async function loadInitialData() {
    try {
      const [teacherList, roomList] = await Promise.all([
        pb.collection('teacher').getFullList({ sort: 'name' }),
        pb.collection('roomType').getFullList({ expand: 'teacher' }),
      ])

      // Keep the full list for status checks
      allTeachers = teacherList

      // Only show active (non-disabled) teachers in the dropdown
      teachers = teacherList.filter((t) => t.status !== 'disabled')

      // Auto-unassign any room whose teacher is disabled — fire-and-forget in parallel
      const disabledTeacherIds = new Set(teacherList.filter((t) => t.status === 'disabled').map((t) => t.id))
      const roomsToFix = roomList.filter((r) => r.teacher && disabledTeacherIds.has(r.teacher))
      if (roomsToFix.length > 0) {
        await Promise.all(roomsToFix.map((r) => pb.collection('roomType').update(r.id, { teacher: null })))
        // Reflect the fix locally so the grid shows Unassigned immediately
        roomsToFix.forEach((r) => {
          r.teacher = null
          r.expand = {}
        })
      }

      // Sort naturally using JS localeCompare
      rooms = roomList.sort((a, b) => {
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      })
    } catch (err) {
      toast.error('Failed to synchronize data')
    }
  }

  function checkTeacherOccupancy(teacherId) {
    if (!teacherId) return null
    const assigned = rooms.find((r) => r.teacher === teacherId && r.id !== formData.id && r.status === 'enabled')
    return assigned ? assigned.name : null
  }

  async function saveRoom() {
    const trimmedName = formData.name.trim()
    if (!trimmedName) return toast.error('Room name is required')

    // 1. Check if name already exists (Local Check)
    const nameExists = rooms.find((r) => r.name.toLowerCase() === trimmedName.toLowerCase() && r.id !== formData.id)
    if (nameExists) return toast.error(`A room named "${trimmedName}" already exists!`)

    // Prepare payload
    let payload = {
      name: trimmedName,
      roomType: formData.roomType,
      maxStudents: formData.maxStudents,
      status: formData.status,
    }

    // Handle teacher assignment based on room status
    if (formData.status === 'disabled') {
      // If room is disabled, always set teacher to null
      payload.teacher = null
    } else {
      // Only check teacher occupancy for enabled rooms
      const occupiedByName = checkTeacherOccupancy(formData.selectedTeacherId)
      if (occupiedByName) return toast.error(`Teacher already assigned to ${occupiedByName}`)
      payload.teacher = formData.selectedTeacherId || null
    }

    try {
      if (formData.id) {
        await pb.collection('roomType').update(formData.id, payload)
        toast.success('Room updated')
      } else {
        await pb.collection('roomType').create(payload)
        toast.success('Room created')
      }

      closeModal()
      await loadInitialData()
    } catch (err) {
      // Handle Database Rejection
      if (err.status === 400) {
        toast.error('Save failed: This room name is already in use.')
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
      status: room.status || 'enabled', // Add status with fallback
    }
    showModal = true
  }

  function closeModal() {
    showModal = false
    formData = {
      id: null,
      name: '',
      roomType: 'mtm',
      maxStudents: 0,
      selectedTeacherId: '',
      status: 'enabled',
    }
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

  // 1. Initialize the Grid ONLY ONCE
  $effect(() => {
    if (gridElement && !gridInstance) {
      gridInstance = new Grid({
        columns: ['Room Name', 'Type', 'Capacity', 'Teacher', 'Status', { name: 'Actions', sort: false }],
        data: [], // Start empty
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

    // This ONLY runs when the component is actually destroyed
    return () => {
      if (gridInstance) {
        gridElement.innerHTML = ''
        gridInstance = null
      }
    }
  })

  // 2. Update the data whenever 'rooms' changes
  $effect(() => {
    const currentRooms = rooms

    if (gridInstance && currentRooms.length >= 0) {
      const data = currentRooms.map((r) => {
        // Determine teacher display: show "(Disabled)" badge if teacher is inactive
        const assignedTeacher = r.expand?.teacher
        const teacherName = assignedTeacher
          ? assignedTeacher.status === 'disabled'
            ? `${assignedTeacher.name} (Disabled)`
            : assignedTeacher.name
          : 'Unassigned'

        // Status badge with appropriate styling
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
            h(
              'button',
              {
                className: 'btn btn-xs btn-outline btn-info',
                onclick: () => openEdit(r),
              },
              'Edit'
            ),
            h(
              'button',
              {
                className: 'btn btn-xs btn-outline btn-error',
                onclick: () => deleteRoom(r.id),
              },
              'Delete'
            ),
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

      <!-- Main Form Container -->
      <div class="flex flex-col gap-5">
        <!-- Room Name Input -->
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

        <!-- Two Column Inputs Split -->
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

        <!-- Status Selection -->
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
          {#if formData.status === 'disabled' && formData.selectedTeacherId}
            <label class="label">
              <span class="label-text-alt text-warning">⚠️ Teacher will be removed when saving</span>
            </label>
          {/if}
        </div>

        <!-- Assigned Teacher Input -->
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
            {#each teachers as t}
              <option value={t.id}>{t.name}</option>
            {/each}
          </select>
          {#if formData.status === 'disabled'}
            <label class="label">
              <span class="label-text-alt text-error">Teacher assignments are disabled for inactive rooms</span>
            </label>
          {/if}
        </div>
      </div>

      <!-- Action Footer Buttons -->
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
  /* Forces the vertical scrollbar to always reserve its layout space */
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
