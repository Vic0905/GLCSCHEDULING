<script>
  import { onMount } from 'svelte'
  import { Grid, h } from 'gridjs'
  import { toast } from 'svelte-sonner'
  import { pb } from '../../../../../lib/Pocketbase.svelte'

  // --- State Management (Svelte 5 Runes) ---
  let subjects = $state([])
  let showModal = $state(false)
  let gridElement = $state(null)
  let gridInstance = null

  // Form State grouped into one object
  let formData = $state({
    id: null,
    name: '',
  })

  // --- Logic ---

  async function loadInitialData() {
    try {
      const records = await pb.collection('subject').getFullList({
        sort: '-created',
      })

      // Sort naturally using JS localeCompare like Room does
      subjects = records.sort((a, b) => {
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      })
    } catch (err) {
      toast.error('Failed to synchronize data')
    }
  }

  async function saveSubject() {
    const trimmedName = formData.name.trim()
    if (!trimmedName) return toast.error('Subject name is required')

    // Check if name already exists (Local Check)
    const nameExists = subjects.find((s) => s.name.toLowerCase() === trimmedName.toLowerCase() && s.id !== formData.id)
    if (nameExists) return toast.error(`A subject named "${trimmedName}" already exists!`)

    try {
      const payload = {
        name: trimmedName,
      }

      if (formData.id) {
        await pb.collection('subject').update(formData.id, payload)
        toast.success('Subject updated')
      } else {
        await pb.collection('subject').create(payload)
        toast.success('Subject created')
      }

      closeModal()
      await loadInitialData()
    } catch (err) {
      if (err.status === 400) {
        toast.error('Save failed: This subject name is already in use.')
      } else {
        toast.error('An unexpected error occurred.')
      }
    }
  }

  function openEdit(subject) {
    formData = {
      id: subject.id,
      name: subject.name,
    }
    showModal = true
  }

  function closeModal() {
    showModal = false
    formData = { id: null, name: '' }
  }

  async function deleteSubject(id) {
    if (confirm('Are you sure you want to delete this subject?')) {
      try {
        await pb.collection('subject').delete(id)
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
        columns: [
          { name: 'Subject Name', width: '300px' },
          { name: 'Actions', width: '200px', sort: false },
        ],
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

    return () => {
      if (gridInstance) {
        gridElement.innerHTML = ''
        gridInstance = null
      }
    }
  })

  // 2. Update the data whenever 'subjects' changes
  $effect(() => {
    const currentSubjects = subjects

    if (gridInstance && currentSubjects.length >= 0) {
      const data = currentSubjects.map((s) => {
        return [
          s.name,
          h('div', { className: 'flex gap-2 justify-center' }, [
            h(
              'button',
              {
                className: 'btn btn-xs btn-outline btn-info',
                onclick: () => openEdit(s),
              },
              'Edit'
            ),
            h(
              'button',
              {
                className: 'btn btn-xs btn-outline btn-error',
                onclick: () => deleteSubject(s.id),
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
      <h1 class="text-3xl font-extrabold tracking-tight text-base-content">Subject Information</h1>
    </div>
    <div class="flex items-center gap-4">
      <button class="btn btn-outline btn-primary shadow-sm" onclick={() => (showModal = true)}> Add Subject </button>
    </div>
  </header>

  <section class="card bg-base-100 border border-base-200">
    <div class="card-body p-0">
      <div bind:this={gridElement}></div>
    </div>
  </section>
</main>

{#if showModal}
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal modal-open bg-black/40" role="dialog" onclick={(e) => e.target === e.currentTarget && closeModal()}>
    <div class="modal-box max-w-md border border-base-300 p-6">
      <div class="flex justify-between items-center mb-6">
        <h3 class="font-bold text-xl text-base-content">{formData.id ? 'Update' : 'Create'} Subject</h3>
        <button class="btn btn-sm btn-circle btn-ghost" onclick={closeModal}>✕</button>
      </div>

      <div class="flex flex-col gap-5">
        <div class="form-control w-full">
          <label class="label py-1" for="subject-name">
            <span class="label-text font-semibold text-base-content">Subject Name</span>
          </label>
          <input
            id="subject-name"
            bind:value={formData.name}
            type="text"
            class="input input-bordered w-full focus:input-primary"
            placeholder="e.g. Mathematics"
          />
        </div>
      </div>

      <div class="modal-action mt-8 gap-2">
        <button class="btn btn-ghost px-6" onclick={closeModal}>Cancel</button>
        <button class="btn btn-primary px-6 shadow-sm" onclick={saveSubject}>
          {formData.id ? 'Save Changes' : 'Create Subject'}
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
