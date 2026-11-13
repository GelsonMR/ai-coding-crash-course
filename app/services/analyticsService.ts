import { eq, sql } from "drizzle-orm";
import { db } from "~/db";
import { courses, enrollments, purchases } from "~/db/schema";

// ─── Analytics Service ───
// Aggregated instructor-facing metrics across an instructor's courses.
// Uses a few grouped queries scoped by instructor (no per-course lookups).

export type CourseStats = {
  studentCount: number;
  earningsCents: number;
  completionRate: number | null; // 0–1; null when no enrollments
};

export type InstructorAnalytics = {
  totals: CourseStats;
  byCourse: Record<number, CourseStats>;
};

function emptyStats(): CourseStats {
  return { studentCount: 0, earningsCents: 0, completionRate: null };
}

function rate(completed: number, enrolled: number): number | null {
  return enrolled === 0 ? null : completed / enrolled;
}

export function getInstructorAnalytics(
  instructorId: number
): InstructorAnalytics {
  const instructorCourses = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.instructorId, instructorId))
    .all();

  const enrollmentCounts = db
    .select({
      courseId: enrollments.courseId,
      count: sql<number>`count(*)`,
      completed: sql<number>`count(${enrollments.completedAt})`,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(eq(courses.instructorId, instructorId))
    .groupBy(enrollments.courseId)
    .all();

  const earnings = db
    .select({
      courseId: purchases.courseId,
      total: sql<number>`coalesce(sum(${purchases.amountPaid}), 0)`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(courses.instructorId, instructorId))
    .groupBy(purchases.courseId)
    .all();

  const byCourse: Record<number, CourseStats> = {};
  for (const course of instructorCourses) {
    byCourse[course.id] = emptyStats();
  }
  let totalCompleted = 0;
  for (const row of enrollmentCounts) {
    byCourse[row.courseId].studentCount = row.count;
    byCourse[row.courseId].completionRate = rate(row.completed, row.count);
    totalCompleted += row.completed;
  }
  for (const row of earnings) {
    byCourse[row.courseId].earningsCents = row.total;
  }

  const totals = emptyStats();
  for (const stats of Object.values(byCourse)) {
    totals.studentCount += stats.studentCount;
    totals.earningsCents += stats.earningsCents;
  }
  // Pooled across all enrollments, not an average of per-course rates.
  totals.completionRate = rate(totalCompleted, totals.studentCount);

  return { totals, byCourse };
}
