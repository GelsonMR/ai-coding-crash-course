import { eq, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  enrollments,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
} from "~/db/schema";

// ─── Analytics Service ───
// Aggregated instructor-facing metrics across an instructor's courses.
// Uses a few grouped queries scoped by instructor (no per-course lookups).

export type CourseStats = {
  studentCount: number;
  earningsCents: number;
  completionRate: number | null; // 0–1; null when no enrollments
  avgQuizScore: number | null; // 0–1; null when no quiz attempts
};

export type InstructorAnalytics = {
  totals: CourseStats;
  byCourse: Record<number, CourseStats>;
};

function emptyStats(): CourseStats {
  return {
    studentCount: 0,
    earningsCents: 0,
    completionRate: null,
    avgQuizScore: null,
  };
}

// numerator ÷ denominator, or null when there is nothing to measure.
function ratioOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
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

  // One row per (student, quiz) pair: that student's best score on that quiz.
  const bestScores = db
    .select({
      courseId: modules.courseId,
      best: sql<number>`max(${quizAttempts.score})`.as("best"),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(courses.instructorId, instructorId))
    .groupBy(quizAttempts.userId, quizAttempts.quizId, modules.courseId)
    .as("best_scores");

  const quizScores = db
    .select({
      courseId: bestScores.courseId,
      scoreSum: sql<number>`sum(${bestScores.best})`,
      pairCount: sql<number>`count(*)`,
    })
    .from(bestScores)
    .groupBy(bestScores.courseId)
    .all();

  const byCourse: Record<number, CourseStats> = {};
  for (const course of instructorCourses) {
    byCourse[course.id] = emptyStats();
  }
  let totalCompleted = 0;
  for (const row of enrollmentCounts) {
    byCourse[row.courseId].studentCount = row.count;
    byCourse[row.courseId].completionRate = ratioOrNull(row.completed, row.count);
    totalCompleted += row.completed;
  }
  for (const row of earnings) {
    byCourse[row.courseId].earningsCents = row.total;
  }

  let totalScoreSum = 0;
  let totalPairCount = 0;
  for (const row of quizScores) {
    byCourse[row.courseId].avgQuizScore = ratioOrNull(
      row.scoreSum,
      row.pairCount
    );
    totalScoreSum += row.scoreSum;
    totalPairCount += row.pairCount;
  }

  const totals = emptyStats();
  for (const stats of Object.values(byCourse)) {
    totals.studentCount += stats.studentCount;
    totals.earningsCents += stats.earningsCents;
  }
  // Pooled across all enrollments / (student, quiz) pairs, not an average of
  // per-course values.
  totals.completionRate = ratioOrNull(totalCompleted, totals.studentCount);
  totals.avgQuizScore = ratioOrNull(totalScoreSum, totalPairCount);

  return { totals, byCourse };
}
