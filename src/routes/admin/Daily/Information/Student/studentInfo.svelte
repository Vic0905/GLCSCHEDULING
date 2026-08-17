<script>
  import { onMount, tick } from 'svelte'
  import { Grid, h } from 'gridjs'

  import { toast } from 'svelte-sonner'
  import Papa from 'papaparse'
  import { pb } from '../../../../../lib/Pocketbase.svelte'

  // ── Constants ─────────────────────────────────────────────────────────────
  const STATUS_OPTIONS = ['new', 'old', 'graduated', 'changed', 'extended']
  const STATUS_BADGE = {
    new: 'badge-success',
    old: 'badge-info',
    graduated: 'badge-warning',
    extended: 'badge-secondary',
    changed: 'badge-error',
  }
  const BULK_DRAFT_KEY = 'student_bulk_draft'
  const BLANK_FORM = {
    id: null,
    name: '',
    englishName: '',
    course: '',
    level: '',
    remarks: '',
    colorRemark: '', // ← add this
    status: 'new',
    start: '',
    end: '',
    isChanged: false,
    isExtended: false,
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let students = $state([])
  let showModal = $state(false)
  let showBulkModal = $state(false)
  let gridElement = $state(null)
  let gridInstance = null
  let isProcessing = $state(false)
  let importProgress = $state({ current: 0, total: 0 })
  let showImportModal = $state(false)
  let importStage = $state('')
  let selectedStudents = $state(new Set())
  let formData = $state({ ...BLANK_FORM })
  let bulkRawInput = $state('')
  let bulkDefaultStatus = $state('new')

  // ── State ─────────────────────────────────────────────────────────────────
  let viewedStudent = $state(null)
  let viewSchedules = $state([])
  let isLoadingSchedule = $state(false)

  let scheduleDate = $derived(getScheduleEndDate(viewedStudent))

  // ── Derived: schedule for the student's END DATE only ──────────────────────
  let dayPeriods = $derived(() => {
    const map = new Map()
    for (const s of viewSchedules) {
      const ts = s.expand?.timeslot
      if (!ts) continue
      if (!map.has(ts.id)) {
        map.set(ts.id, { start: ts.start, end: ts.end, entries: [] })
      }
      map.get(ts.id).entries.push({
        subject: s.expand?.subject?.name ?? '—',
        teacher: s.expand?.teacher?.name ?? '—',
        room: s.expand?.room?.name ?? '—',
      })
    }
    return [...map.values()].sort((a, b) => a.start.localeCompare(b.start))
  })

  // ── Derived for edit mode ──────────────────────────────────────────────────
  let editMode = $derived(formData.isChanged ? 'changed' : formData.isExtended ? 'extended' : 'normal')

  // ── Derived ───────────────────────────────────────────────────────────────
  let stats = $derived({
    total: students.length,
    new: students.filter((s) => s.status === 'new').length,
    old: students.filter((s) => s.status === 'old').length,
    graduated: students.filter((s) => s.status === 'graduated').length,
    extended: students.filter((s) => s.status === 'extended').length,
    changed: students.filter((s) => s.status === 'changed').length,
  })

  let bulkPreview = $derived(
    bulkRawInput
      .split('\n')
      .map((line) => {
        const delimiter = line.includes('\t') ? '\t' : ','
        const [name = '', englishName = '', course = '', level = '', remarks = '', start = '', end = ''] = line
          .split(delimiter)
          .map((s) => s.trim())
        return { englishName, name, course, level, remarks, start: parseDateToISO(start), end: parseDateToISO(end) }
      })
      .filter(
        (row, i, arr) =>
          row.englishName.length > 0 &&
          arr.findIndex((r) => r.englishName.toLowerCase() === row.englishName.toLowerCase()) === i
      )
  )

  let hasDraft = $derived(!!localStorage.getItem(BULK_DRAFT_KEY) && !bulkRawInput.trim())

  $effect(() => {
    bulkRawInput.trim() ? localStorage.setItem(BULK_DRAFT_KEY, bulkRawInput) : localStorage.removeItem(BULK_DRAFT_KEY)
  })

  // ── Helpers ───────────────────────────────────────────────────────────────
  const getId = (rel) => (!rel ? null : Array.isArray(rel) ? rel[0] : typeof rel === 'object' ? rel.id : rel)
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1)

  // ── ADDED: active (non-graduated) name-collision helper, shared by the
  // single-add, bulk-add, and CSV-import duplicate checks below ─────────────
  const isActiveNameMatch = (s, name) => s.englishName?.toLowerCase() === name.toLowerCase() && s.status !== 'graduated'

  function parseDateToISO(str) {
    if (!str) return null
    const match = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
    if (!match) return str
    let [, month, day, year] = match
    if (year.length === 2) year = '20' + year
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  async function batchFetch(requests) {
    const base = pb.baseUrl.replace(/\/+$/, '') // strip trailing slash(es)
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

  async function batchFetchChunked(requests, chunkSize = 5000, onProgress) {
    const allResults = []
    for (let i = 0; i < requests.length; i += chunkSize) {
      const chunk = requests.slice(i, i + chunkSize)
      const res = await batchFetch(chunk)
      allResults.push(...res)
      onProgress?.(allResults.length, requests.length)
    }
    return allResults
  }

  // ── ADDED: bounded-concurrency runner for work that can't be batched
  // (e.g. user creation, which needs sequential read-then-decide logic per item,
  // but doesn't need to be fully serial across items) ─────────────────────────
  async function runWithConcurrency(items, limit, worker, onProgress) {
    const results = new Array(items.length)
    let idx = 0
    let completed = 0
    async function next() {
      while (idx < items.length) {
        const i = idx++
        results[i] = await worker(items[i], i)
        completed++
        onProgress?.(completed, items.length)
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, next))
    return results
  }

  function getScheduleEndDate(student) {
    if (!student?.end) return null
    const d = new Date(student.end)
    const startD = new Date(student.start)
    while (d.getDay() !== 5) {
      d.setDate(d.getDate() - 1)
    }

    // if that Friday is before start, there's no Friday in range
    if (d < startD) return null

    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  // ── UPDATED: User account helper ────────────────────────────────────────────
  // Only reuse an existing account when a CURRENTLY ACTIVE (non-graduated)
  // student already owns it under this exact English name — that's the one
  // legitimate "same person" case. A graduated student sharing the same name
  // is treated as a different person and always gets a brand-new account, so
  // two people never end up sharing one login. Uniqueness then falls through
  // to the username-suffix loop below (e.g. JOHNDOE → JOHNDOE1).
  async function createStudentUser(englishName) {
    const trimmedName = englishName.trim()

    try {
      const activeOwner = await pb
        .collection('student')
        .getFirstListItem(`englishName="${trimmedName}" && status != "graduated" && user != ""`)
      if (activeOwner.user) return getId(activeOwner.user)
    } catch {
      // no active student owns an account under this name — fall through and create one
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
        email: `${username}@student.local`,
        emailVisibility: true,
        password: '00000000',
        passwordConfirm: '00000000',
        firstName: trimmedName,
        role: 'student',
      })
      return user.id
    } catch (err) {
      console.error('Failed to create user for', englishName, err)
      toast.error(`User creation failed: ${err?.response?.message || err.message}`)
      if (err?.response?.data) console.error(JSON.stringify(err.response.data))
      return null
    }
  }

  // ── Student ID helper ──────────────────────────────────────────────────────
  async function getNextStudentId() {
    try {
      const records = await pb.collection('student').getFullList({ fields: 'studentId' })
      const max = records.reduce((m, r) => Math.max(m, Number(r.studentId) || 0), 0)
      return max + 1
    } catch {
      return 1
    }
  }
  const padId = (n) => String(n).padStart(5, '0')

  // ── Grid ──────────────────────────────────────────────────────────────────
  function renderGrid(records) {
    if (!gridElement) return

    if (gridInstance) {
      gridInstance.destroy()
      gridInstance = null
      gridElement.innerHTML = ''
    }

    const data = records.map((s) => [
      h('input', {
        type: 'checkbox',
        className: 'checkbox checkbox-sm checkbox-neutral',
        checked: selectedStudents.has(s.id),
        onChange: (e) => {
          const next = new Set(selectedStudents)
          e.target.checked ? next.add(s.id) : next.delete(s.id)
          selectedStudents = next
        },
      }),
      s.studentId || '-',
      s.englishName || '-',
      s.name || '-',
      s.course || '-',
      s.level || '-',
      s.remarks
        ? h('span', { style: s.colorRemark ? `color:${s.colorRemark};font-weight:600;` : '' }, s.remarks)
        : h('span', { style: 'color:rgba(0,0,0,0.25);font-size:12px;' }, '—'),
      s.start ? s.start.slice(0, 10) : '-',
      s.end ? s.end.slice(0, 10) : '-',
      h('span', { className: `badge badge-sm ${STATUS_BADGE[s.status] ?? 'badge-neutral'}` }, s.status ?? 'new'),
      h('div', { className: 'flex gap-1 justify-center flex-wrap' }, [
        h(
          'button',
          {
            className: `btn btn-xs btn-outline ${viewedStudent?.id === s.id ? 'btn-primary' : 'btn-ghost'}`,
            onclick: (e) => {
              const btn = e.target
              loadStudentSchedules(s) // updates state & fetches schedule
              // Immediately update the button text (DOM only)
              if (viewedStudent?.id === s.id) {
                btn.textContent = 'Hide'
              } else {
                btn.textContent = 'View'
              }
            },
          },
          viewedStudent?.id === s.id ? 'Hide' : 'View'
        ),
        h('button', { className: 'btn btn-xs btn-outline btn-info', onclick: () => openEdit(s) }, 'Edit'),
        h('button', { className: 'btn btn-xs btn-outline btn-error', onclick: () => deleteStudent(s.id) }, 'Delete'),
      ]),
    ])

    gridInstance = new Grid({
      columns: [
        { name: '-', width: '50px', sort: false },
        { name: 'Student ID', width: '80px' },
        { name: 'English Name', width: '100px' },
        { name: 'Name', width: '120px' },
        { name: 'Course', width: '90px' },
        { name: 'Level', width: '90px' },
        { name: 'Remarks', width: '90px' },
        { name: 'Start', width: '90px' },
        { name: 'End', width: '90px' },
        { name: 'Status', width: '90px' },
        { name: 'Actions', width: '150px', sort: false },
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

  // ── Data ──────────────────────────────────────────────────────────────────
  async function loadStudents() {
    try {
      let records = await pb.collection('student').getFullList({ sort: '-studentId' })
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

      const toPromote = records.filter((s) => s.status === 'new' && s.start && new Date(s.start) < cutoff)
      const toGraduate = records.filter((s) => s.end && new Date(s.end) < today && s.status !== 'graduated')
      // ── ADDED: un-graduate if the end date has since been moved into the future
      const toUngraduate = records.filter((s) => s.status === 'graduated' && s.end && new Date(s.end) >= today)

      if (toPromote.length || toGraduate.length || toUngraduate.length) {
        await Promise.allSettled([
          ...toPromote.map(({ id }) => pb.collection('student').update(id, { status: 'old' })),
          ...toGraduate.map(({ id }) => pb.collection('student').update(id, { status: 'graduated' })),
          ...toUngraduate.map(({ id, start }) =>
            pb.collection('student').update(id, { status: start && new Date(start) < cutoff ? 'old' : 'new' })
          ),
        ])
        records = await pb.collection('student').getFullList({ sort: '-studentId' })
      }

      students = records
      await tick()
      renderGrid(students)
    } catch {
      toast.error('Failed to load students')
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────
  async function saveStudent() {
    const trimmed = formData.englishName.trim()
    if (!trimmed) return toast.error('English Name is required')

    isProcessing = true
    try {
      if (formData.id && formData.isChanged) {
        const original = students.find((s) => s.id === formData.id)
        const nextId = await getNextStudentId()
        await pb.collection('student').create({
          studentId: padId(nextId),
          name: original.name,
          englishName: original.englishName,
          course: formData.course.trim(),
          level: original.level,
          remarks: original.remarks,
          colorRemark: original.colorRemark,
          status: 'changed',
          start: formData.start || null,
          end: original.end || null,
          user: original.user,
        })
        toast.success('New record created with changed course')
      } else if (formData.id && formData.isExtended) {
        const original = students.find((s) => s.id === formData.id)
        const nextId = await getNextStudentId()
        await pb.collection('student').create({
          studentId: padId(nextId),
          name: original.name,
          englishName: original.englishName,
          course: formData.course.trim(),
          level: original.level,
          remarks: original.remarks,
          colorRemark: original.colorRemark,
          status: 'extended',
          start: formData.start || null,
          end: formData.end || null,
          user: original.user,
        })
        toast.success('New record created with extended course and dates')
      } else {
        // ── UPDATED: only block on a name collision with a still-ACTIVE
        // student. A name matching only a graduated student is allowed
        // through — createStudentUser() will give it its own fresh account. ──
        if (!formData.id) {
          const dupe = students.find((s) => isActiveNameMatch(s, trimmed))
          if (dupe) return toast.error(`"${trimmed}" already exists`)
        }
        const nextId = !formData.id ? await getNextStudentId() : null
        const payload = {
          ...(nextId !== null && { studentId: padId(nextId) }),
          name: formData.name.trim(),
          englishName: trimmed,
          course: formData.course.trim(),
          level: formData.level.trim(),
          remarks: formData.remarks.trim(),
          colorRemark: formData.colorRemark,
          status: formData.status,
          start: formData.start || null,
          end: formData.end || null,
        }
        if (formData.id) {
          await pb.collection('student').update(formData.id, payload)

          const original = students.find((s) => s.id === formData.id)
          if (original?.user && original.englishName?.toLowerCase() !== trimmed.toLowerCase()) {
            const newBase = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '')
            if (newBase) {
              try {
                await pb.collection('users').update(original.user, {
                  firstName: trimmed,
                  username: newBase,
                })
              } catch (userErr) {
                console.warn('Could not sync username:', userErr)
                toast.warning('Student updated but username sync failed — username may already be taken')
              }
            }
          }
        } else {
          const newStudent = await pb.collection('student').create(payload)
          const userId = await createStudentUser(trimmed)
          if (userId) await pb.collection('student').update(newStudent.id, { user: userId })
        }
        toast.success(formData.id ? 'Student updated' : 'Student added')
      }
      closeModal()
      await loadStudents()
    } catch (err) {
      toast.error(err?.status === 400 ? 'English Name already in use' : 'Unexpected error')
    } finally {
      isProcessing = false
    }
  }

  async function deleteStudent(id) {
    if (!confirm('Delete this student?')) return

    try {
      const student = await pb.collection('student').getOne(id)
      const userId = getId(student.user)

      await pb.collection('student').delete(id) // cascade handles dailySchedule cleanup

      if (userId) {
        try {
          await pb.collection('users').delete(userId)
        } catch (userErr) {
          console.error('Failed to delete linked user:', userErr)
          toast.warning('Student deleted, but linked user account could not be removed')
        }
      }

      toast.success('Student deleted')
      await loadStudents()
    } catch (err) {
      console.error(err)
      toast.error(err?.response?.message || 'Failed to delete student')
    }
  }

  async function saveBulkStudents() {
    if (!bulkPreview.length) return toast.error('No names entered')

    isProcessing = true
    // ── UPDATED: only names held by ACTIVE students count as "existing" ──
    const existingNames = new Set(
      students.filter((s) => s.status !== 'graduated').map((s) => s.englishName?.toLowerCase())
    )
    const toCreate = bulkPreview.filter((row) => !existingNames.has(row.englishName.toLowerCase()))
    const skipped = bulkPreview.length - toCreate.length

    if (!toCreate.length) {
      toast.error(`All ${skipped} name(s) are duplicates`)
      isProcessing = false
      return
    }
    const nextId = await getNextStudentId()

    try {
      const results = await batchFetchChunked(
        toCreate.map((row, i) => ({
          method: 'POST',
          url: '/api/collections/student/records',
          body: { ...row, status: bulkDefaultStatus, studentId: padId(nextId + i) },
        }))
      )
      const added = results.filter((r) => r.status >= 200 && r.status < 300).length
      const failed = results.filter((r) => r.status < 200 || r.status >= 300).length

      // ── UPDATED: create user accounts with bounded concurrency instead of
      // one-by-one, then batch-link the resulting user IDs back to students ──
      const successful = toCreate
        .map((row, i) => ({ row, result: results[i] }))
        .filter(({ result }) => result.status >= 200 && result.status < 300)

      const userIds = await runWithConcurrency(successful, 8, ({ row }) => createStudentUser(row.englishName))

      const linkRequests = successful
        .map(({ result }, i) =>
          userIds[i]
            ? {
                method: 'PATCH',
                url: `/api/collections/student/records/${result.body.id}`,
                body: { user: userIds[i] },
              }
            : null
        )
        .filter(Boolean)

      if (linkRequests.length) await batchFetchChunked(linkRequests, 50)

      toast.success(
        [added && `${added} added`, skipped && `${skipped} skipped`, failed && `${failed} failed`]
          .filter(Boolean)
          .join(', ')
      )
      bulkRawInput = ''
      closeBulkModal()
      await loadStudents()
    } catch {
      toast.error('Batch request failed')
    } finally {
      isProcessing = false
    }
  }

  // ── Bulk selection ────────────────────────────────────────────────────────
  const selectAll = () => {
    selectedStudents = new Set(students.map((s) => s.id))
    renderGrid(students)
  }
  const clearSelection = () => {
    selectedStudents = new Set()
    renderGrid(students)
  }

  async function bulkDeleteStudents() {
    if (!selectedStudents.size) return toast.error('No students selected')
    if (!confirm(`Delete ${selectedStudents.size} student(s)?`)) return

    isProcessing = true

    try {
      const ids = Array.from(selectedStudents)

      // ── UPDATED: use already-loaded state instead of re-fetching with a
      // giant "id=... || id=..." filter string, which breaks past ~50 ids ──
      const records = students.filter((s) => ids.includes(s.id))

      // ── UPDATED: batched deletes instead of N individual concurrent
      // DELETE requests. Cascade delete on dailySchedule.student handles
      // schedule cleanup automatically, so no manual lookup/delete needed. ──
      const results = await batchFetchChunked(
        ids.map((id) => ({
          method: 'DELETE',
          url: `/api/collections/student/records/${id}`,
        }))
      )
      const deleted = results.filter((r) => r.status >= 200 && r.status < 300).length
      const failed = results.length - deleted

      const userResults = await Promise.allSettled(
        records.filter((s) => s.user).map((s) => pb.collection('users').delete(s.user))
      )
      const userFailures = userResults.filter((r) => r.status === 'rejected')
      if (userFailures.length) {
        console.error('Some linked users failed to delete:', userFailures)
        toast.warning(`${userFailures.length} linked user account(s) could not be removed`)
      }

      toast.success([deleted && `${deleted} deleted`, failed && `${failed} failed`].filter(Boolean).join(', '))
      selectedStudents = new Set()
      await loadStudents()
    } catch (err) {
      console.error(err)
      toast.error('Bulk delete failed')
    } finally {
      isProcessing = false
    }
  }

  // ── CSV ───────────────────────────────────────────────────────────────────
  function downloadTemplate() {
    const csv = Papa.unparse({
      fields: ['English Name', 'Name', 'Course', 'Level', 'Remarks', 'Start', 'End', 'Status'],
      data: [],
    })
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'students_template.csv'
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
              englishName: (normalized['english name'] || normalized['englishname'] || '').trim(),
              name: (normalized['name'] || '').trim(),
              course: (normalized['course'] || '').trim(),
              level: (normalized['level'] || '').trim(),
              remarks: (normalized['remarks'] || '').trim(),
              start: parseDateToISO((normalized['start'] || '').trim()),
              end: parseDateToISO((normalized['end'] || '').trim()),
              status: (normalized['status'] || 'new').trim(),
            }
          })
          .filter((r) => r.englishName)

        if (!rows.length) return toast.error('No valid rows found in CSV')

        // ── UPDATED: only names held by ACTIVE students count as "existing" ──
        const existingNames = new Set(
          students.filter((s) => s.status !== 'graduated').map((s) => s.englishName?.toLowerCase())
        )
        const toCreate = rows.filter((r) => !existingNames.has(r.englishName.toLowerCase()))
        const skipped = rows.length - toCreate.length

        if (!toCreate.length) {
          toast.error(`All ${skipped} row(s) already exist`)
          e.target.value = ''
          return
        }
        const nextId = await getNextStudentId()

        isProcessing = true
        showImportModal = true
        importStage = 'Creating student records'
        importProgress = { current: 0, total: toCreate.length }
        try {
          const results = await batchFetchChunked(
            toCreate.map((row, i) => ({
              method: 'POST',
              url: '/api/collections/student/records',
              body: { ...row, studentId: padId(nextId + i) },
            })),
            50,
            (current, total) => (importProgress = { current, total })
          )
          const added = results.filter((r) => r.status >= 200 && r.status < 300).length
          const failed = results.filter((r) => r.status < 200 || r.status >= 300).length

          // ── UPDATED: create user accounts with bounded concurrency (8 at a
          // time) instead of one-by-one, then batch-link user IDs back to
          // their student records instead of individual sequential updates.
          // Each stage updates importStage/importProgress so the modal keeps
          // moving instead of appearing frozen after the first stage. ──
          const successful = toCreate
            .map((row, i) => ({ row, result: results[i] }))
            .filter(({ result }) => result.status >= 200 && result.status < 300)

          let userIds = []
          if (successful.length) {
            importStage = 'Creating user accounts'
            importProgress = { current: 0, total: successful.length }
            userIds = await runWithConcurrency(
              successful,
              8,
              ({ row }) => createStudentUser(row.englishName),
              (current, total) => (importProgress = { current, total })
            )
          }

          const linkRequests = successful
            .map(({ result }, i) =>
              userIds[i]
                ? {
                    method: 'PATCH',
                    url: `/api/collections/student/records/${result.body.id}`,
                    body: { user: userIds[i] },
                  }
                : null
            )
            .filter(Boolean)

          if (linkRequests.length) {
            importStage = 'Linking accounts'
            importProgress = { current: 0, total: linkRequests.length }
            await batchFetchChunked(linkRequests, 50, (current, total) => (importProgress = { current, total }))
          }

          importStage = 'Refreshing list'
          toast.success(
            [added && `${added} imported`, skipped && `${skipped} skipped`, failed && `${failed} failed`]
              .filter(Boolean)
              .join(', ')
          )
          await loadStudents()
        } catch {
          toast.error('CSV import failed')
        } finally {
          isProcessing = false
          showImportModal = false
          importStage = ''
          e.target.value = ''
        }
      },
      error: () => toast.error('Failed to parse CSV'),
    })
  }

  // ── Modal helpers ─────────────────────────────────────────────────────────
  const openEdit = (s) => {
    formData = {
      id: s.id,
      name: s.name || '',
      englishName: s.englishName || '',
      course: s.course || '',
      level: s.level || '',
      remarks: s.remarks || '',
      colorRemark: s.colorRemark || '', // ← add this
      status: s.status || 'new',
      start: s.start ? s.start.slice(0, 10) : '',
      end: s.end ? s.end.slice(0, 10) : '',
      isChanged: false,
      isExtended: false,
    }
    showModal = true
  }

  const closeModal = () => {
    showModal = false
    formData = { ...BLANK_FORM }
  }
  const openBulkModal = () => {
    bulkRawInput = localStorage.getItem(BULK_DRAFT_KEY) ?? ''
    bulkDefaultStatus = 'new'
    showBulkModal = true
  }
  const closeBulkModal = () => {
    showBulkModal = false
  }

  // ── Formatting helpers for the printable day-schedule ───────────────────────
  function fmtTime(t) {
    if (!t) return '—'
    const [h, m = '00'] = t.split(':')
    return `${parseInt(h, 10)}:${m}`
  }

  function fmtFullDate(d) {
    return new Date(d + 'T00:00:00')
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      .toUpperCase()
  }

  async function loadStudentSchedules(student) {
    if (viewedStudent?.id === student.id) {
      viewedStudent = null
      viewSchedules = []
      return
    }

    viewedStudent = student
    viewSchedules = []
    isLoadingSchedule = true

    const targetDate = getScheduleEndDate(student) // ← replaces the inline ternary
    if (!targetDate) {
      isLoadingSchedule = false
      return
    }

    try {
      viewSchedules = await pb.collection('dailySchedule').getFullList({
        filter: `student = "${student.id}" && date >= "${targetDate} 00:00:00.000Z" && date <= "${targetDate} 23:59:59.999Z"`,
        expand: 'timeslot,room,teacher,subject',
        sort: 'date',
      })
    } catch {
      toast.error('Failed to load schedules')
    } finally {
      isLoadingSchedule = false
    }
  }

  $effect(() => () => {
    if (gridInstance && gridElement) {
      gridElement.innerHTML = ''
      gridInstance = null
    }
  })
  onMount(loadStudents)
</script>

<main class="p-8 max-w-[100rem] mx-auto space-y-6">
  <!-- Header -->
  <header class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-6">
    <div>
      <h1 class="text-3xl font-extrabold tracking-tight text-base-content">Student Information</h1>
      <div class="flex gap-4 mt-2 text-sm text-base-content/60">
        <span>Total <strong class="text-base-content">{stats.total}</strong></span>
        <span>New <strong class="text-success">{stats.new}</strong></span>
        <span>Old <strong class="text-info">{stats.old}</strong></span>
        <span>Graduated <strong class="text-warning">{stats.graduated}</strong></span>
        <span>Extended <strong class="text-secondary">{stats.extended}</strong></span>
        <span>Changed <strong class="text-error">{stats.changed}</strong></span>
      </div>
    </div>
    <div class="flex gap-2">
      <input id="csv-import-input" type="file" accept=".csv" class="hidden" onchange={handleCSVImport} />
      <button class="btn btn-outline shadow-sm" onclick={downloadTemplate}> Download Template </button>
      <button class="btn btn-outline shadow-sm" onclick={triggerCSVImport} disabled={isProcessing}> Import CSV </button>
      <button class="btn btn-outline shadow-sm relative" onclick={openBulkModal}>
        Add Multiple
        {#if hasDraft}<span
            class="absolute -top-1 -right-1 w-2.5 h-2.5 bg-warning rounded-full border-2 border-base-100"
          ></span>{/if}
      </button>
    </div>
  </header>

  <!-- Bulk action bar -->
  {#if selectedStudents.size > 0}
    <div class="card bg-base-100 border border-base-200 px-5 py-3">
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <p class="text-sm font-medium">
          <strong>{selectedStudents.size}</strong> student{selectedStudents.size > 1 ? 's' : ''} selected
        </p>
        <div class="flex flex-wrap gap-2">
          <button class="btn btn-xs btn-ghost" onclick={selectAll}>Select All</button>
          <button class="btn btn-xs btn-ghost" onclick={clearSelection}>Clear</button>
          <div class="divider divider-horizontal my-0 mx-1"></div>
          <button class="btn btn-xs btn-error" onclick={bulkDeleteStudents} disabled={isProcessing}>
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

  <!-- Printable end-date schedule -->
  {#if viewedStudent}
    <section class="card bg-base-100 border-2 border-black overflow-hidden">
      <div class="card-body p-0">
        <!-- Title bar -->
        <div class="flex items-center justify-between border-b-2 border-black px-6 py-4">
          <h2 class="text-2xl sm:text-3xl font-extrabold tracking-tight uppercase">Student's Schedule</h2>
          <button
            class="btn btn-sm btn-ghost btn-circle"
            onclick={() => {
              viewedStudent = null
              viewSchedules = []
            }}>✕</button
          >
        </div>

        <!-- Info row -->
        <div class="grid grid-cols-1 sm:grid-cols-3 border-b-2 border-black text-sm">
          <div class="border-b sm:border-b-0 sm:border-r-2 border-black px-4 py-3">
            <span class="font-bold uppercase">Name: </span>{viewedStudent.name || '—'}
          </div>
          <div class="border-b sm:border-b-0 sm:border-r-2 border-black px-4 py-3">
            <span class="font-bold uppercase">English Name: </span>{viewedStudent.englishName || '—'}
          </div>
          <div class="px-4 py-3 font-bold text-error">
            {#if scheduleDate}
              DATE: {fmtFullDate(scheduleDate)} ONLY
            {:else}
              No schedule date for this student
            {/if}
          </div>
        </div>

        {#if isLoadingSchedule}
          <div class="flex justify-center py-10">
            <span class="loading loading-spinner loading-md"></span>
          </div>
        {:else if !scheduleDate}
          <div class="text-center text-base-content/40 py-10 text-sm">
            This student has no start date set, so no schedule day can be shown.
          </div>
        {:else if dayPeriods().length === 0}
          <div class="text-center text-base-content/40 py-10 text-sm">
            No schedule found for {fmtFullDate(scheduleDate)}.
          </div>
        {:else}
          <div class="overflow-x-auto">
            <table class="table w-full text-center border-collapse">
              <thead>
                <tr class="text-sm font-bold uppercase">
                  <th class="border-2 border-black py-2">Period</th>
                  <th class="border-2 border-black py-2">Time</th>
                  <th class="border-2 border-black py-2">Teacher</th>
                  <th class="border-2 border-black py-2">Cubicle/Room</th>
                  <th class="border-2 border-black py-2">Class/Subject</th>
                </tr>
              </thead>
              <tbody>
                {#each dayPeriods() as p, i}
                  <tr>
                    <td class="border-2 border-black font-bold py-2">{i + 1}</td>
                    <td class="border-2 border-black py-2 whitespace-nowrap">
                      {fmtTime(p.start)} - {fmtTime(p.end)}
                    </td>
                    <td class="border-2 border-black py-2">{p.entries.map((e) => e.teacher).join(', ')}</td>
                    <td class="border-2 border-black py-2">{p.entries.map((e) => e.room).join(', ')}</td>
                    <td class="border-2 border-black py-2">{p.entries.map((e) => e.subject).join(', ')}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    </section>
  {/if}
</main>

<!-- CSV Import Progress Modal -->
{#if showImportModal}
  <div class="modal modal-open bg-black/40">
    <div class="modal-box max-w-sm border border-base-300 p-6 text-center">
      <span class="loading loading-spinner loading-md text-primary mb-3"></span>
      <h3 class="font-bold text-lg mb-1">Importing Students</h3>
      <p class="text-sm text-base-content/60 mb-4">{importStage}…</p>
      <div class="w-full bg-base-200 rounded-full h-3 overflow-hidden mb-2">
        <div
          class="bg-primary h-3 transition-all duration-300"
          style="width: {importProgress.total ? Math.round((importProgress.current / importProgress.total) * 100) : 0}%"
        ></div>
      </div>
      <p class="text-xs text-base-content/50">{importProgress.current} / {importProgress.total}</p>
    </div>
  </div>
{/if}

<!-- Add / Edit Modal -->
{#if showModal}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions a11y_interactive_supports_focus -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div class="modal modal-open bg-black/40" role="dialog" onclick={(e) => e.target === e.currentTarget && closeModal()}>
    <div class="modal-box max-w-lg border border-base-300 p-6">
      <div class="flex justify-between items-center mb-6">
        <h3 class="font-bold text-xl">{formData.id ? 'Update' : 'Add'} Student</h3>
        <button class="btn btn-sm btn-circle btn-ghost" onclick={closeModal}>✕</button>
      </div>

      <div class="flex flex-col gap-5">
        <!-- Primary Information -->
        <div>
          <p class="text-xs font-semibold text-base-content/40 uppercase tracking-wide mb-3">Primary Information</p>
          <div class="grid grid-cols-2 gap-4">
            <div class="form-control">
              <label class="label py-1" for="english-name">
                <span class="label-text font-semibold">
                  English Name <span class="opacity-40 font-normal text-xs">(required)</span>
                </span>
              </label>
              <input
                id="english-name"
                bind:value={formData.englishName}
                type="text"
                disabled={!!formData.id && (formData.isChanged || formData.isExtended)}
                class="input input-bordered w-full focus:input-primary disabled:opacity-50"
              />
            </div>
            <div class="form-control">
              <label class="label py-1" for="student-name">
                <span class="label-text font-semibold">
                  Name <span class="opacity-40 font-normal text-xs">(optional)</span>
                </span>
              </label>
              <input
                id="student-name"
                bind:value={formData.name}
                type="text"
                disabled={!!formData.id && (formData.isChanged || formData.isExtended)}
                class="input input-bordered w-full focus:input-primary disabled:opacity-50"
              />
            </div>
          </div>
        </div>

        <!-- Academic Information -->
        <div>
          <p class="text-xs font-semibold text-base-content/40 uppercase tracking-wide mb-3">Academic Information</p>
          <div class="grid grid-cols-3 gap-4">
            <div class="form-control">
              <label class="label py-1" for="course"><span class="label-text font-semibold">Course</span></label>
              <input
                id="course"
                bind:value={formData.course}
                type="text"
                class="input input-bordered w-full focus:input-primary"
              />
            </div>
            <div class="form-control">
              <label class="label py-1" for="level"><span class="label-text font-semibold">Level</span></label>
              <input
                id="level"
                bind:value={formData.level}
                type="text"
                disabled={!!formData.id && (formData.isChanged || formData.isExtended)}
                class="input input-bordered w-full focus:input-primary disabled:opacity-50"
              />
            </div>
            <div class="form-control">
              <label class="label py-1" for="remarks"><span class="label-text font-semibold">Remarks</span></label>
              <input
                id="remarks"
                bind:value={formData.remarks}
                type="text"
                disabled={!!formData.id && (formData.isChanged || formData.isExtended)}
                class="input input-bordered w-full focus:input-primary disabled:opacity-50"
              />
            </div>
            <!-- Remark Color -->
            <div class="form-control col-span-3">
              <label class="label py-1" for="color-remark">
                <span class="label-text font-semibold">Remark Color</span>
              </label>
              <div class="flex items-center gap-3">
                <input
                  id="color-remark"
                  bind:value={formData.colorRemark}
                  type="color"
                  class="w-12 h-10 rounded-lg border border-base-300 cursor-pointer p-0.5 bg-base-100"
                />
                <input
                  type="text"
                  value={formData.colorRemark}
                  maxlength="7"
                  class="input input-bordered input-sm w-28 font-mono text-sm focus:input-primary"
                  placeholder="#ffffff"
                  oninput={(e) => {
                    const val = e.target.value
                    if (/^#[0-9a-fA-F]{6}$/.test(val)) formData.colorRemark = val
                  }}
                  onblur={(e) => {
                    if (!/^#[0-9a-fA-F]{6}$/.test(e.target.value)) e.target.value = formData.colorRemark
                  }}
                />
                {#if typeof EyeDropper !== 'undefined'}
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost btn-square"
                    title="Pick color from screen"
                    onclick={async () => {
                      try {
                        const dropper = new EyeDropper()
                        const result = await dropper.open()
                        formData.colorRemark = result.sRGBHex
                      } catch {}
                    }}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="m2 22 1-1h3l9-9" /><path d="M3 21v-3l9-9" />
                      <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8z" />
                    </svg>
                  </button>
                {/if}
                <!-- Live preview -->
                {#if formData.colorRemark}
                  <span
                    class="badge badge-lg font-medium"
                    style="background:{formData.colorRemark}; color:#fff; border:none;"
                  >
                    {formData.remarks || 'Preview'}
                  </span>
                {/if}
              </div>
            </div>
          </div>
        </div>

        <!-- Edit Mode (only in edit, not add) -->
        {#if formData.id}
          <div class="rounded-lg border border-base-300 bg-base-200/50 px-4 py-3 flex flex-col gap-3">
            <p class="text-xs font-semibold text-base-content/40 uppercase tracking-wide">Edit Mode</p>
            <label class="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                class="checkbox checkbox-sm checkbox-error mt-0.5"
                checked={formData.isChanged}
                onchange={(e) => {
                  formData.isChanged = e.target.checked
                  if (e.target.checked) formData.isExtended = false
                }}
              />
              <div>
                <p class="font-semibold text-sm">Change</p>
                <p class="text-xs text-base-content/50">
                  Creates a new record with an updated Course. Original is preserved.
                </p>
              </div>
            </label>
            <label class="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                class="checkbox checkbox-sm checkbox-secondary mt-0.5"
                checked={formData.isExtended}
                onchange={(e) => {
                  formData.isExtended = e.target.checked
                  if (e.target.checked) formData.isChanged = false
                }}
              />
              <div>
                <p class="font-semibold text-sm">Extend</p>
                <p class="text-xs text-base-content/50">
                  Creates a new record with updated Course, Start & End dates. Original is preserved.
                </p>
              </div>
            </label>
          </div>
        {/if}

        <!-- Start & End Dates -->
        <div class="grid grid-cols-2 gap-4">
          <div class="form-control">
            <label class="label py-1" for="start-date"><span class="label-text font-semibold">Start Date</span></label>
            <input
              id="start-date"
              bind:value={formData.start}
              type="date"
              disabled={false}
              class="input input-bordered w-full focus:input-primary disabled:opacity-50"
            />
          </div>
          <div class="form-control">
            <label class="label py-1" for="end-date"><span class="label-text font-semibold">End Date</span></label>
            <input
              id="end-date"
              bind:value={formData.end}
              type="date"
              disabled={!!formData.id && formData.isChanged}
              class="input input-bordered w-full focus:input-primary disabled:opacity-50"
            />
          </div>
        </div>
      </div>

      <div class="modal-action mt-8 gap-2">
        <button class="btn btn-ghost px-6" onclick={closeModal} disabled={isProcessing}>Cancel</button>
        <button class="btn btn-primary px-6 shadow-sm" onclick={saveStudent} disabled={isProcessing}>
          {#if isProcessing}
            <span class="loading loading-spinner loading-sm"></span>
          {:else}
            {formData.id ? 'Save Changes' : 'Add Student'}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Bulk Add Modal -->
{#if showBulkModal}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions a11y_interactive_supports_focus -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    class="modal modal-open bg-black/40"
    role="dialog"
    onclick={(e) => e.target === e.currentTarget && closeBulkModal()}
  >
    <div class="modal-box max-w-2xl border border-base-300 p-6">
      <div class="flex justify-between items-center mb-1">
        <h3 class="font-bold text-xl">Add Multiple Students</h3>
        <button class="btn btn-sm btn-circle btn-ghost" onclick={closeBulkModal}>✕</button>
      </div>
      <p class="text-sm text-base-content/50 mb-2">One student per line. Duplicates are skipped automatically.</p>
      <div class="alert alert-info py-2 px-3 mb-4 text-xs">
        Paste from <strong>Google Sheets</strong> or type manually with commas. Column order:
        <code class="font-mono font-bold mx-1">Name · EnglishName · Course · Level · Remarks · Start · End</code>
        — only <strong>English Name</strong> is required.
      </div>

      <div class="flex flex-col gap-5">
        <div class="form-control">
          <label class="label py-1" for="bulk-names">
            <span class="label-text font-semibold">Student Lines</span>
            <span class="label-text-alt flex gap-2">
              {#if bulkPreview.length}<span class="text-base-content/50">{bulkPreview.length} detected</span>{/if}
              {#if bulkRawInput.trim()}
                <button
                  class="text-error text-xs underline"
                  onclick={() => {
                    bulkRawInput = ''
                    localStorage.removeItem(BULK_DRAFT_KEY)
                  }}>Clear</button
                >
              {/if}
            </span>
          </label>
          <textarea
            id="bulk-names"
            bind:value={bulkRawInput}
            class="textarea textarea-bordered w-full h-40 resize-none focus:textarea-primary font-mono text-sm"
            placeholder="Full name&#9;English name&#9;Course&#9;Level&#9;Remarks&#9;"
          ></textarea>
        </div>

        <div class="bg-base-200 rounded-lg p-3">
          <p class="text-xs font-semibold text-base-content/60 uppercase tracking-wide mb-2">Preview</p>
          <div class="overflow-x-auto max-h-48 overflow-y-auto">
            <table class="table table-xs w-full">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>English Name</th>
                  <th>Course</th>
                  <th>Level</th>
                  <th>Remarks</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {#each bulkPreview as row}
                  <!-- ── UPDATED: only flag as duplicate if an ACTIVE student
                  holds this name — a graduated match is allowed through ── -->
                  {@const isDupe = students.some((s) => isActiveNameMatch(s, row.englishName))}
                  <tr class={isDupe ? 'opacity-40' : ''}>
                    <td class="text-base-content/70">{row.name || '—'}</td>
                    <td class={isDupe ? 'line-through' : 'font-medium'}>{row.englishName}</td>
                    <td class="text-base-content/70">{row.course || '—'}</td>
                    <td class="text-base-content/70">{row.level || '—'}</td>
                    <td class="text-base-content/70">{row.remarks || '—'}</td>
                    <td class="text-base-content/70">{row.start || '—'}</td>
                    <td class="text-base-content/70">{row.end || '—'}</td>
                    <td>
                      {#if isDupe}
                        <span class="badge badge-xs badge-warning">duplicate</span>
                      {:else}
                        <span class="badge badge-xs {STATUS_BADGE[bulkDefaultStatus]}">{bulkDefaultStatus}</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="modal-action mt-8 gap-2">
        <button class="btn btn-ghost px-6" onclick={closeBulkModal} disabled={isProcessing}>Cancel</button>
        <button
          class="btn btn-primary px-6 shadow-sm"
          onclick={saveBulkStudents}
          disabled={!bulkPreview.length || isProcessing}
        >
          {#if isProcessing}
            <span class="loading loading-spinner loading-sm"></span>
          {:else}
            {@const toAdd = bulkPreview.filter(
              (row) => !students.some((s) => isActiveNameMatch(s, row.englishName))
            ).length}
            Add {toAdd} Student{toAdd !== 1 ? 's' : ''}
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
