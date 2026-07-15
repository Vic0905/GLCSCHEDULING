<script>
  import { current } from '../lib/Pocketbase.svelte'
  import { onMount, onDestroy } from 'svelte'

  let openMenus = $state({ daily: false, management: false })

  function handleOutsideClick(event) {
    const openDetails = document.querySelectorAll('details[open]')
    openDetails.forEach((el) => {
      if (!el.contains(event.target)) {
        el.removeAttribute('open')
      }
    })

    // Admin flyout menus (Daily Booking / Management) are intentionally
    // NOT closed here — they should only toggle via their own button.
  }

  onMount(() => {
    document.addEventListener('click', handleOutsideClick)
  })

  onDestroy(() => {
    document.removeEventListener('click', handleOutsideClick)
  })
</script>

{#if current.user && current.user.role === 'admin'}
  <!-- admin routes -->
  <li class="relative" data-admin-menu>
    <button
      onclick={() => (openMenus.daily = !openMenus.daily)}
      class="flex items-center justify-between px-4 py-2 hover:bg-base-200 rounded-lg w-full"
    >
      <span class="text-xs mr-2 sm:hidden md:inline">{openMenus.daily ? '▶' : '◀'}</span>
      Daily Booking
    </button>
    {#if openMenus.daily}
      <ul
        class="z-50 text-xs p-2 bg-base-100 shadow-md rounded-lg
               static flex flex-col w-full mt-1
               sm:absolute sm:right-full sm:top-0 sm:mr-2 sm:flex-row sm:w-auto sm:mt-0 sm:whitespace-nowrap
               sm:max-w-[calc(100vw-2rem)] sm:overflow-x-auto"
      >
        <li><a href="/#/daily/input/mtmschedule">MTM Input</a></li>
        <li><a href="/#/daily/input/grpschedule">GRP Input</a></li>
        <li><a href="/#/daily/input/subclass">Sub Input</a></li>
        <li><a href="/#/daily/views/teacherview">Teacher view</a></li>
        <li><a href="/#/daily/views/studentview">Student View</a></li>
        <li><a href="/#/daily/input/graduatingstudent">Graduating Student</a></li>
      </ul>
    {/if}
  </li>
  <li class="relative" data-admin-menu>
    <button
      onclick={() => (openMenus.management = !openMenus.management)}
      class="flex items-center justify-between px-4 py-2 hover:bg-base-200 rounded-lg w-full"
    >
      Management
      <span class="text-xs ml-2">{openMenus.management ? '◀' : '▶'}</span>
    </button>
    {#if openMenus.management}
      <ul
        class="z-50 text-xs p-2 bg-base-100 shadow-md rounded-lg
               static flex flex-col w-full mt-1
               sm:absolute sm:left-full sm:top-0 sm:flex-row sm:w-auto sm:mt-0 sm:whitespace-nowrap
               sm:max-w-[calc(100vw-2rem)] sm:overflow-x-auto"
      >
        <li><a href="/#/daily/information/log/activitylog">Activity Log</a></li>
        <li><a href="/#/daily/information/holiday/holidaypicker">Holiday Picker</a></li>
        <li><a href="/#/daily/information/student/studentinfo">Student Info</a></li>
        <li><a href="/#/daily/information/teacher/teacherinfo">Teacher Info</a></li>
        <li><a href="/#/daily/information/room/room">Room Info</a></li>
        <li><a href="/#/daily/information/subject/subject">Subject Info</a></li>
        <li><a href="/#/daily/information/custom/customsched">Memo Info</a></li>
        <li><a href="/#/daily/information/print/printtable">Print Table</a></li>
      </ul>
    {/if}
  </li>
{:else if current.user && current.user.role === 'teacher'}
  <!-- teacher routes -->
{:else if current.user && current.user.role === 'student'}
  <!-- student routes -->
{:else if current.user && current.user.role === 'staff'}
  <!-- staff routes -->
  <li>
    <details>
      <summary>Input</summary>
      <ul class="relative z-50 text-xs p-2">
        <li><a href="/#/daily/input/subclass">SubClass Input</a></li>
        <li><a href="/#/daily/views/checker">Checker</a></li>
      </ul>
    </details>
  </li>
{:else}
  <!-- public routes -->
{/if}
