import wrap from 'svelte-spa-router/wrap'

export const adminRoutes = {
  '/': wrap({
    asyncComponent: () => import('../routes/admin/Dashboard/Dashboard.svelte'),
  }),
  '/daily/input/mtmschedule': wrap({
    asyncComponent: () => import('../routes/admin/Daily/Input/MtmSchedule.svelte'),
  }),
  '/daily/input/grpschedule': wrap({
    asyncComponent: () => import('../routes/admin/Daily/Input/GrpSchedule.svelte'),
  }),
  '/daily/input/subclass': wrap({
    asyncComponent: () => import('../routes/admin/Daily/Input/subClass.svelte'),
  }),
  '/daily/input/graduatingstudent': wrap({
    asyncComponent: () => import('../routes/admin/Daily/Input/GraduatingStudent.svelte'),
  }),

  '/daily/views/teacherview': wrap({
    asyncComponent: () => import('../routes/admin/Daily/views/TeacherView.svelte'),
  }),
  '/daily/views/studentview': wrap({
    asyncComponent: () => import('../routes/admin/Daily/views/StudentView.svelte'),
  }),

  '/daily/information/student/studentinfo': wrap({
    asyncComponent: () => import('../routes/admin/Daily/Information/Student/studentInfo.svelte'),
  }),
  '/daily/information/teacher/teacherinfo': wrap({
    asyncComponent: () => import('../routes/admin/Daily/Information/Teacher/TeacherInfo.svelte'),
  }),
  '/daily/information/room/room': wrap({
    asyncComponent: () => import('../routes/admin/Daily/Information/Room/Room.svelte'),
  }),
  '/daily/information/subject/subject': wrap({
    asyncComponent: () => import('../routes/admin/Daily/Information/Subject/Subject.svelte'),
  }),
  '/daily/information/log/activitylog': wrap({
    asyncComponent: () => import('../routes/admin/Daily/Information/Log/ActivityLog.svelte'),
  }),
  '/daily/information/custom/customsched': wrap({
    asyncComponent: () => import('../routes/admin/Daily/Information/Custom/customSched.svelte'),
  }),
  '/daily/information/print/printtable': wrap({
    asyncComponent: () => import('../routes/admin/Daily/Information/Print/printTable.svelte'),
  }),
  '*': wrap({
    asyncComponent: () => import('../routes/PageNotFound/PageNotFound.svelte'),
  }),
}

export const guestRoutes = {
  // '/': wrap({
  //   asyncComponent: () => import('../routes/LandingPage/LandingPage.svelte'),
  // }),
  '/': wrap({
    asyncComponent: () => import('../routes/auth/Login.svelte'),
  }),
  '/login': wrap({
    asyncComponent: () => import('../routes/auth/Login.svelte'),
  }),
  '*': wrap({
    asyncComponent: () => import('../routes/PageNotFound/PageNotFound.svelte'),
  }),
}

export const staffRoutes = {
  '/': wrap({
    asyncComponent: () => import('../routes/admin/Dashboard/StaffDash.svelte'),
  }),
  '/daily/input/subclass': wrap({
    asyncComponent: () => import('../routes/admin/Daily/Input/subClass.svelte'),
  }),
  '/daily/views/checker': wrap({
    asyncComponent: () => import('../routes/admin/Daily/views/Checker.svelte'),
  }),
  '*': wrap({
    asyncComponent: () => import('../routes/PageNotFound/PageNotFound.svelte'),
  }),
}

export const teacherRoutes = {
  '/': wrap({
    asyncComponent: () => import('../routes/admin/Dashboard/TeacherDash.svelte'),
  }),
  '/daily/views/teachertable': wrap({
    asyncComponent: () => import('../routes/admin/Daily/views/TeacherTable.svelte'),
  }),
  '*': wrap({
    asyncComponent: () => import('../routes/PageNotFound/PageNotFound.svelte'),
  }),
}

export const studentRoutes = {
  '/': wrap({
    asyncComponent: () => import('../routes/admin/Dashboard/StudentDash.svelte'),
  }),
  '/daily/views/studenttable': wrap({
    asyncComponent: () => import('../routes/admin/Daily/views/StudentTable.svelte'),
  }),
  '*': wrap({
    asyncComponent: () => import('../routes/PageNotFound/PageNotFound.svelte'),
  }),
}
