import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getInstructorAnalytics } from "./analyticsService";
import { enrollUser, markEnrollmentComplete } from "./enrollmentService";
import { createPurchase, createTeamPurchase } from "./purchaseService";
import { redeemCoupon } from "./couponService";
import { createModule } from "./moduleService";
import { createLesson } from "./lessonService";
import { createQuiz, recordAttempt } from "./quizService";

function createUser(email: string, role = schema.UserRole.Student) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role })
    .returning()
    .get();
}

function createCourse(
  slug: string,
  instructorId: number,
  status = schema.CourseStatus.Published
) {
  return testDb
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: slug,
      salesCopy: slug,
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function createQuizInCourse(courseId: number, title = "Quiz") {
  const module = createModule(courseId, `${title} module`, null);
  const lesson = createLesson(module.id, `${title} lesson`, null, null, null, null);
  return createQuiz(lesson.id, title, 0.7);
}

describe("analyticsService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("getInstructorAnalytics", () => {
    it("returns zero totals and no per-course entries for an instructor with no courses", () => {
      const newInstructor = createUser(
        "new-instructor@example.com",
        schema.UserRole.Instructor
      );

      const analytics = getInstructorAnalytics(newInstructor.id);

      expect(analytics.totals).toEqual({
        studentCount: 0,
        earningsCents: 0,
        completionRate: null,
        avgQuizScore: null,
      });
      expect(analytics.byCourse).toEqual({});
    });

    it("counts enrollments per course, only for the instructor's own courses", () => {
      const otherInstructor = createUser(
        "other@example.com",
        schema.UserRole.Instructor
      );
      const secondCourse = createCourse("second", base.instructor.id);
      const otherCourse = createCourse("other", otherInstructor.id);
      const alice = createUser("alice@example.com");
      const bob = createUser("bob@example.com");

      enrollUser(base.user.id, base.course.id, false, false);
      enrollUser(alice.id, base.course.id, false, false);
      enrollUser(bob.id, secondCourse.id, false, false);
      enrollUser(alice.id, otherCourse.id, false, false);
      enrollUser(bob.id, otherCourse.id, false, false);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.byCourse[base.course.id].studentCount).toBe(2);
      expect(analytics.byCourse[secondCourse.id].studentCount).toBe(1);
      expect(analytics.byCourse[otherCourse.id]).toBeUndefined();
      expect(analytics.totals.studentCount).toBe(3);
    });

    it("counts coupon-redeemed enrollments but not unredeemed team seats", () => {
      const buyer = createUser("buyer@example.com");
      const seatHolder = createUser("seat@example.com");
      const { coupons } = createTeamPurchase(
        buyer.id,
        base.course.id,
        15000,
        "US",
        3
      );

      redeemCoupon(coupons[0].code, seatHolder.id, "US");

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.byCourse[base.course.id].studentCount).toBe(1);
      expect(analytics.totals.studentCount).toBe(1);
    });

    it("counts a team purchase's amount once, with coupon redemptions adding nothing", () => {
      const buyer = createUser("buyer@example.com");
      const seatA = createUser("seat-a@example.com");
      const seatB = createUser("seat-b@example.com");
      const { coupons } = createTeamPurchase(
        buyer.id,
        base.course.id,
        15000,
        "US",
        3
      );

      redeemCoupon(coupons[0].code, seatA.id, "US");
      redeemCoupon(coupons[1].code, seatB.id, "US");

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.byCourse[base.course.id].earningsCents).toBe(15000);
      expect(analytics.totals.earningsCents).toBe(15000);
    });

    it("sums the amount actually paid, including PPP-discounted purchases", () => {
      const secondCourse = createCourse("second", base.instructor.id);
      const alice = createUser("alice@example.com");
      const bob = createUser("bob@example.com");

      createPurchase(base.user.id, base.course.id, 4999, "US");
      createPurchase(alice.id, base.course.id, 1250, "IN");
      createPurchase(bob.id, secondCourse.id, 2000, "BR");

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.byCourse[base.course.id].earningsCents).toBe(6249);
      expect(analytics.byCourse[secondCourse.id].earningsCents).toBe(2000);
      expect(analytics.totals.earningsCents).toBe(8249);
    });

    it("ignores purchases of another instructor's courses", () => {
      const otherInstructor = createUser(
        "other@example.com",
        schema.UserRole.Instructor
      );
      const otherCourse = createCourse("other", otherInstructor.id);

      createPurchase(base.user.id, base.course.id, 3000, "US");
      createPurchase(base.user.id, otherCourse.id, 9999, "US");

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.totals.earningsCents).toBe(3000);
      expect(
        getInstructorAnalytics(otherInstructor.id).totals.earningsCents
      ).toBe(9999);
    });

    it("includes draft and archived courses in per-course stats and totals", () => {
      const draft = createCourse(
        "draft",
        base.instructor.id,
        schema.CourseStatus.Draft
      );
      const archived = createCourse(
        "archived",
        base.instructor.id,
        schema.CourseStatus.Archived
      );
      const alice = createUser("alice@example.com");

      enrollUser(alice.id, draft.id, false, false);
      createPurchase(alice.id, draft.id, 1000, "US");
      enrollUser(base.user.id, archived.id, false, false);
      createPurchase(base.user.id, archived.id, 2500, "US");

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.byCourse[draft.id]).toEqual({
        studentCount: 1,
        earningsCents: 1000,
        completionRate: 0,
        avgQuizScore: null,
      });
      expect(analytics.byCourse[archived.id]).toEqual({
        studentCount: 1,
        earningsCents: 2500,
        completionRate: 0,
        avgQuizScore: null,
      });
      expect(analytics.totals).toEqual({
        studentCount: 2,
        earningsCents: 3500,
        completionRate: 0,
        avgQuizScore: null,
      });
    });

    it("includes courses with no activity (and no quizzes) as zero entries with null rates", () => {
      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.byCourse).toEqual({
        [base.course.id]: {
          studentCount: 0,
          earningsCents: 0,
          completionRate: null,
          avgQuizScore: null,
        },
      });
      expect(analytics.totals).toEqual({
        studentCount: 0,
        earningsCents: 0,
        completionRate: null,
        avgQuizScore: null,
      });
    });

    it("computes completion rate per course as completed ÷ enrolled", () => {
      const secondCourse = createCourse("second", base.instructor.id);
      const alice = createUser("alice@example.com");
      const bob = createUser("bob@example.com");
      const carol = createUser("carol@example.com");

      enrollUser(base.user.id, base.course.id, false, false);
      enrollUser(alice.id, base.course.id, false, false);
      enrollUser(bob.id, base.course.id, false, false);
      enrollUser(carol.id, base.course.id, false, false);
      markEnrollmentComplete(alice.id, base.course.id);
      enrollUser(alice.id, secondCourse.id, false, false);
      enrollUser(bob.id, secondCourse.id, false, false);
      markEnrollmentComplete(alice.id, secondCourse.id);
      markEnrollmentComplete(bob.id, secondCourse.id);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.byCourse[base.course.id].completionRate).toBe(0.25);
      expect(analytics.byCourse[secondCourse.id].completionRate).toBe(1);
    });

    it("pools the total completion rate across all enrollments rather than averaging course rates", () => {
      const bigCourse = createCourse("big", base.instructor.id);
      const alice = createUser("alice@example.com");
      const bob = createUser("bob@example.com");
      const carol = createUser("carol@example.com");

      // Small course: 1 of 1 completed (100%).
      enrollUser(base.user.id, base.course.id, false, false);
      markEnrollmentComplete(base.user.id, base.course.id);
      // Big course: 0 of 3 completed (0%).
      enrollUser(alice.id, bigCourse.id, false, false);
      enrollUser(bob.id, bigCourse.id, false, false);
      enrollUser(carol.id, bigCourse.id, false, false);

      const analytics = getInstructorAnalytics(base.instructor.id);

      // Pooled: 1 ÷ 4. An average of course rates would give 0.5.
      expect(analytics.totals.completionRate).toBe(0.25);
    });

    it("averages each student's best score per quiz, so retries don't drag it down", () => {
      const quizA = createQuizInCourse(base.course.id, "A");
      const quizB = createQuizInCourse(base.course.id, "B");
      const alice = createUser("alice@example.com");

      // base.user on quiz A: 0.4 then 0.9 → best 0.9
      recordAttempt(base.user.id, quizA.id, 0.4, false);
      recordAttempt(base.user.id, quizA.id, 0.9, true);
      // alice on quiz A: 0.6 then 0.5 → best 0.6
      recordAttempt(alice.id, quizA.id, 0.6, false);
      recordAttempt(alice.id, quizA.id, 0.5, false);
      // alice on quiz B: 0.3 → best 0.3
      recordAttempt(alice.id, quizB.id, 0.3, false);

      const analytics = getInstructorAnalytics(base.instructor.id);

      // (0.9 + 0.6 + 0.3) / 3 pairs
      expect(analytics.byCourse[base.course.id].avgQuizScore).toBeCloseTo(0.6);
    });

    it("returns a null quiz score for a course whose quizzes have no attempts", () => {
      createQuizInCourse(base.course.id);
      enrollUser(base.user.id, base.course.id, false, false);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.byCourse[base.course.id].avgQuizScore).toBeNull();
      expect(analytics.totals.avgQuizScore).toBeNull();
    });

    it("pools the total quiz score across all best scores rather than averaging course averages", () => {
      const bigCourse = createCourse("big", base.instructor.id);
      const smallQuiz = createQuizInCourse(base.course.id, "Small");
      const bigQuiz = createQuizInCourse(bigCourse.id, "Big");
      const alice = createUser("alice@example.com");
      const bob = createUser("bob@example.com");
      const carol = createUser("carol@example.com");

      // Small course: one best score of 1.0.
      recordAttempt(base.user.id, smallQuiz.id, 1, true);
      // Big course: three best scores of 0.2.
      recordAttempt(alice.id, bigQuiz.id, 0.2, false);
      recordAttempt(bob.id, bigQuiz.id, 0.2, false);
      recordAttempt(carol.id, bigQuiz.id, 0.2, false);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.byCourse[base.course.id].avgQuizScore).toBeCloseTo(1);
      expect(analytics.byCourse[bigCourse.id].avgQuizScore).toBeCloseTo(0.2);
      // Pooled: (1.0 + 0.2 × 3) / 4 = 0.4. Averaging course averages would give 0.6.
      expect(analytics.totals.avgQuizScore).toBeCloseTo(0.4);
    });

    it("returns a null quiz score for a course with no quizzes, without affecting the total", () => {
      const noQuizCourse = createCourse("no-quiz", base.instructor.id);
      const quiz = createQuizInCourse(base.course.id);
      enrollUser(base.user.id, noQuizCourse.id, false, false);
      recordAttempt(base.user.id, quiz.id, 0.8, true);

      const analytics = getInstructorAnalytics(base.instructor.id);

      expect(analytics.byCourse[noQuizCourse.id].avgQuizScore).toBeNull();
      expect(analytics.byCourse[base.course.id].avgQuizScore).toBeCloseTo(0.8);
      expect(analytics.totals.avgQuizScore).toBeCloseTo(0.8);
    });
  });
});
