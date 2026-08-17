# Onboarding Platform - Project Seed

מסמך זה מסכם את כל ההחלטות שהתקבלו בשלב הגילוי/פרומפט-הנדסה, כדי שאפשר יהיה להתחיל ממנו ישירות לבניית קוד אמיתי.

## החזון
פלטפורמה שמייצרת תוכניות אונבורדינג פרסונליות (חודשיים, לפי תפקיד/ותק/מיקום/היררכיה) בעזרת מספר סוכני AI, עם דשבורד חי לעובד/מנהל/HR.

## ארגון הדמו לפרויקט: Veridian
`Veridian_Master_Data_Pack_v1.xlsx` הוא **מקור האמת** לנתוני הארגון - לא נתרגם אותו ידנית ל-Markdown. סוכני הבנייה יקבלו את הנתונים דרך סקריפט import שקורא ישירות מה-Excel ל-DB (שלב 1). כולל: Employees (עם היררכיית מנהלים אמיתית, כולל Skip Manager), Departments, Teams, Offices, Products, Systems (עם SLA לעובד חדש), Training Catalog (עם Due Dates), Policies.

**הערה**: ארגון קודם (LuminaFlow) שימש לבדיקות פרומפט מוקדמות בלבד - אינו חלק מהפרויקט הפעיל יותר.

## מסמכי יסוד בחבילה זו
- `onboarding-framework.md` - כל עקרונות הבנייה (17 סעיפים, 6 חלקים)
- `Veridian_Master_Data_Pack_v1.xlsx` - יש לצרף בנפרד (קובץ המקור שכבר במחשבך)

## ארכיטקטורת סוכנים (עודכן - ראו "החלטות ארכיטקטורה" מתחת)
Input → תשאול מנהל/ת מגייס/ת (Buddy/Mentor/JD חופשי) → Context Layer → Orchestrator →
  [מומחה תהליכים | כותב תוכן] → Draft → עריכת מנהל/ת → Approve → Activate (חשיפה לעובד + זימוני יומן + פתיחת חומרים בהדרגה)

בנפרד: AI Buddy - agent חי, RAG על שכבת ידע ארגוני + FAQ/Glossary/Culture ייעודיים. **עדכון (סגר GAP קודם)**: שכבת הידע הייעודית ל-Buddy **קיימת עכשיו בפועל** - `Veridian_Knowledge_Base_Content_v1.xlsx` יובא ל-3 טבלאות (`faq`: 20 שורות, `glossary`: 22 שורות - 10 Acronym + 12 Internal Term, `culture`: 16 שורות - Core Value/Feedback Culture/Decision Making/Company Ritual). זו **החליפה** את ה-Glossary/FAQ הכלליים והדלים יותר שהיו ב-master data pack (4/6 עמודות, לא נקראו משום קוד) - לא הרחבה שלהם, סט תוכן נפרד שנועד במפורש לשמש בסיס ל-Buddy, כולל שדות `audience`/`owner`/`source`/`tags`/`last_reviewed` שלא היו קיימים קודם. ראו `MEMORY.md` לפירוט המלא כולל ה-GAP הנפרד (לא נסגר) על `job_family` מול `departments.department`. **ה-GAP שנותר עכשיו הוא באמת רק שה-agent עצמו (פרומפט + RAG) עדיין לא נבנה** - לא תוכן. `faq.answer` של FAQ-014 ("Who is responsible for my onboarding experience?") מגדיר במפורש את גבולות התפקיד של ה-AI Buddy עצמו ("...should not override your manager or HR policies") - מועמד חזק לשילוב ישיר (לא רק שליפה) בפרומפט המערכת של סוכן ה-Buddy כשייבנה.

### החלטות ארכיטקטורה מאז מסמך הזרע הזה
- **"סוכן תפעול" בוטל כתיבה נפרדת** (היה ברשימת 3 הסוכנים במקור). התפקידים שהוא היה אמור למלא - הקצאת אנשי קשר אמיתיים (מנהל/סקיפ/HRBP/באדי) ורצף לוגי/עדיפויות (תקרת 5 פגישות/שבוע, סדר דחייה) - ממומשים בפועל בתוך **Context Layer** (`lib/context.js` - resolveAudienceToken/resolveRole/getByEmail וכו') ו**מומחה התהליכים** (`prompts/process-expert.md` + `lib/plan-validate.js`). ראו commit `95fb82d` שהוסיף את ההפרדה `direct_report`/`team_member` ואת שתי בדיקות הוולידציה העצמאיות - זו בדיוק העבודה שתוכננה ל"סוכן תפעול". התרשים לעיל עודכן בהתאם: 2 סוכני תוכן (מומחה תהליכים, כותב תוכן), לא 3.

## עקרונות ליבה שכבר נבדקו ועובדים (ראו onboarding-framework.md לפירוט מלא)
- מודל 4 מסלולים במקביל (עסק/צוות-ממשקים/תפקיד/מערכות), לא ציר זמן ליניארי יחיד
- יחס למידה↔עשייה משתנה בהדרגה (80/20 ← 20/80 לאורך 8 שבועות)
- מנהל/IC משנה **מבנה**, לא רק תוכן
- מקסימום 5 פגישות/שבוע, עם כללי עדיפות לדחיית עודף (וחריגים תלויי-תפקיד, למשל מנהלים מול הכפיפים שלהם)
- לא ממציאים מידע קריטי - מסמנים GAP במפורש

## סטטוס נוכחי בפועל (עודכן)
| שלב | סטטוס |
|---|---|
| 1. סכימת נתונים + repo | **הושלם** - `db/schema.sql` + `scripts/import-veridian.js`, מייבא משני קבצי xlsx: `Veridian_Master_Data_Pack_v1.xlsx` (185 עובדים, כולל 45 `roles` אחרי סבב Role Catalog Additions) ו-`Veridian_Knowledge_Base_Content_v1.xlsx` (faq/glossary/culture, 20/22/16 שורות). `import-veridian.js` מוריד/יוצר מחדש **רק** את טבלאות הארגון - לא נוגע בטבלאות ה-persistence (ראו שלב 4.5) |
| 2. Context layer | **הושלם** - `lib/context.js` (`buildEmployeeContext`), `lib/dates.js`, `lib/interfaces.js` |
| 3. מומחה תהליכים | **הושלם** - `prompts/process-expert.md` + `lib/plan-validate.js` (2 בדיקות ולידציה עצמאיות: תקרת 5/שבוע, חלון שבועות 1-2 ל-direct_report). כולל את מה שתוכנן במקור ל"סוכן תפעול" (ראו למעלה) |
| 3.5. כותב תוכן | **הושלם** - `prompts/content-writer.md` + `lib/content-writer-agent.js`, מפריד pending-assignment מ-internalGaps |
| 4. Orchestrator | **הושלם** - `lib/orchestrator.js`, `lib/manager-intake.js`: מריץ Context Layer → מיזוג תשאול מנהל/ת מגייס/ת → מומחה תהליכים → ולידציה (עוצר אם נכשל) → כותב תוכן → שמירה |
| 4.5. Persistence | **הושלם** - `lib/persistence.js` + `db/persistence-schema.sql`: טבלאות `manager_intake`/`plans`/`plan_item_status`, `validateMentorSelection` (primary mentor חייב מנהל/ת ישיר/ה או אותו team_id; secondary ללא הגבלה), נבדק שרד restart אמיתי (תהליכי node נפרדים) |
| 5. AI Buddy (RAG) | **שכבת ידע הושלמה** - `faq`/`glossary`/`culture` (20/22/16 שורות) יובאו מ-`Veridian_Knowledge_Base_Content_v1.xlsx` דרך `importKnowledgeBase()` ב-`scripts/import-veridian.js`. **ה-agent עצמו (פרומפט + RAG) עדיין לא התחיל** - זה עדיין השלב הבא, בכוונה לא נגענו בו בסבב הזה |
| 6. רובריקת איכות פורמלית | לא רשמי - פזור בתוך ה-Framework |
| 7-9. דשבורד, DB חי, QA | לא התחילו |

**הערה חשובה**: כל ריצות מומחה התהליכים/כותב התוכן עד כה הן `output/*.manual-example.json` - נוצרו ידנית מול הפרומפט וה-context האמיתיים כי אין `ANTHROPIC_API_KEY` בסביבת הפיתוח הזו. `lib/process-expert-agent.js` ו-`lib/content-writer-agent.js` כתובים ומוכנים לקריאת API אמיתית. `scripts/run-orchestrator.js VRD-1011 --mentor=...` נבדק עד לאותה נקודה בדיוק - המיזוג עם manager intake עובד, הכישלון היחיד הוא קריאת ה-API עצמה.

## GAP מתועד: אין עדיין טריגר אמיתי ל-manager intake (לא לבנות כרגע)
הטריגר האמיתי (עובד/ת חדש/ה נכנס/ת למערכת → מייל אוטומטי למנהל/ת עם קישור לטופס) **לא קיים**. `manager_intake` מוזן כרגע ידנית/CLI (`--buddy=`, `--mentor=` ב-`scripts/run-orchestrator.js`, או קריאה ישירה ל-`resolveManagerIntake`/`saveManagerIntake`), לא דרך טופס אמיתי. דורש בהמשך: טבלת `onboarding_requests` (טריגר כניסת עובד/ת חדש/ה), אינטגרציית email, טופס web - כל אלה שייכים לשלב הדשבורד (שלב 7 למעלה), לא לשכבת ה-persistence הנוכחית.

## המלצה להמשך השיחה הבאה ב-Claude Code
"קרא את README.md ואת docs/PROJECT-README.md, ובוא נדבר על ה-AI Buddy - סוכן RAG חי על שכבת ידע ארגוני + Glossary/FAQ."
