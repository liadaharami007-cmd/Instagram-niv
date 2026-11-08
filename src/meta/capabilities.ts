import type { Provider } from './graph-client.ts';

/**
 * automatic          – runs in the background through an official Meta endpoint.
 * not_supported      – Meta exposes NO endpoint. The product does not automate it and never reports it as done.
 */
export type Support = 'automatic' | 'not_supported';

export interface Capability {
  key: string;
  /** The original requirement this answers (1–5), or 'extra' when it was added later. */
  requirement: '1-follow' | '2-unfollow' | '3-story-likes' | '4-analytics' | '5-safety' | 'extra';
  title: string;
  support: Support;
  /** Login types for which the endpoint exists. Empty for not_supported. */
  providers: Provider[];
  permissions: Partial<Record<Provider, string[]>>;
  /** Job types whose real outcomes prove the capability works for an account. */
  jobTypes: string[];
  note: string;
  source: string;
}

const DOCS = 'https://developers.facebook.com/documentation/instagram-platform';

/** Verified against Meta's Instagram Platform docs (IG User reference, updated Oct 2026). */
export const CAPABILITIES: Capability[] = [
  {
    key: 'follow', requirement: '1-follow', title: 'Follow אוטומטי', support: 'not_supported', providers: [], permissions: {}, jobTypes: [],
    note: 'ל-Meta אין שום endpoint לביצוע Follow (גם לא ב-Facebook Login / Unified Login / Advanced Access). אוטומציה אפשרית רק בעקיפת ההגנות של אינסטגרם — והמערכת לא עושה זאת. כלי התיעוד הידני במערכת אינו מילוי של הדרישה.',
    source: `${DOCS}/instagram-graph-api/reference/ig-user`,
  },
  {
    key: 'unfollow', requirement: '2-unfollow', title: 'Unfollow אוטומטי', support: 'not_supported', providers: [], permissions: {}, jobTypes: [],
    note: 'אין endpoint לביצוע Unfollow ואין endpoint לרשימת עוקבים/נעקבים. המערכת יכולה רק לנתח את קובץ ההורדה הרשמי (מי לא עוקב בחזרה) — הביצוע עצמו ידני.',
    source: `${DOCS}/instagram-graph-api/reference/ig-user`,
  },
  {
    key: 'story_like', requirement: '3-story-likes', title: 'לייקים לסטוריז של אחרים', support: 'not_supported', providers: [], permissions: {}, jobTypes: [],
    note: 'Meta מציינת במפורש בתיעוד ה-Likes API: "Stories is not supported". אין גם API לצפייה בסטוריז של חשבונות אחרים.',
    source: `${DOCS}/instagram-graph-api/reference/ig-user/user-likes`,
  },
  {
    key: 'likes', requirement: '3-story-likes', title: 'לייקים אוטומטיים לפוסטים ורילס של קהל היעד', support: 'automatic', providers: ['facebook_login'],
    permissions: { facebook_login: ['instagram_basic', 'instagram_manage_engagement', 'instagram_manage_insights', 'pages_read_engagement'] }, jobTypes: ['like_media'],
    note: 'ה-API הרשמי היחיד לאינטראקציה (Likes API, 2026): פוסטים, רילס וקרוסלות של חשבונות ציבוריים. לא סטוריז, לא חשבונות פרטיים. Facebook Login בלבד. נעילה לשעה ביותר מ-50 בקשות ב-5 שניות. מציאת הפוסטים — Business Discovery (חשבונות עסקיים/יוצרים בלבד).',
    source: `${DOCS}/instagram-graph-api/reference/ig-user/user-likes`,
  },
  {
    key: 'profile', requirement: '4-analytics', title: 'מספר עוקבים ונתוני פרופיל', support: 'automatic', providers: ['instagram_login', 'facebook_login'],
    permissions: { instagram_login: ['instagram_business_basic'], facebook_login: ['instagram_basic', 'pages_show_list'] }, jobTypes: ['sync_profile'],
    note: 'צילום מצב כל 3 שעות → שינוי יומי/שבועי/חודשי מנתונים אמיתיים בלבד.', source: `${DOCS}/instagram-graph-api/reference/ig-user`,
  },
  {
    key: 'insights', requirement: '4-analytics', title: 'Insights: עוקבים חדשים, follows/unfollows, חשיפה, צפיות, מעורבות', support: 'automatic', providers: ['instagram_login', 'facebook_login'],
    permissions: { instagram_login: ['instagram_business_manage_insights'], facebook_login: ['instagram_manage_insights'] }, jobTypes: ['sync_insights'],
    note: 'follower_count דורש 100+ עוקבים וזמין ל-30 יום אחורה. מדד שלא זמין לחשבון מסומן ולא מוצג כנתון.', source: `${DOCS}/insights`,
  },
  {
    key: 'media', requirement: '4-analytics', title: 'ביצועי פוסטים, רילס וסטוריז שלך', support: 'automatic', providers: ['instagram_login', 'facebook_login'],
    permissions: { instagram_login: ['instagram_business_basic', 'instagram_business_manage_insights'], facebook_login: ['instagram_basic', 'instagram_manage_insights'] },
    jobTypes: ['sync_media', 'sync_stories'], note: 'סטוריז נשמרים כל 4 שעות (זמינים ב-API רק 24 שעות).', source: `${DOCS}/insights`,
  },
  {
    key: 'competitors', requirement: '4-analytics', title: 'השוואת ביצועים למתחרים', support: 'automatic', providers: ['facebook_login'],
    permissions: { facebook_login: ['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'] }, jobTypes: ['sync_competitors', 'enrich_targets'],
    note: 'Business Discovery — חשבונות עסקיים/יוצרים בלבד.', source: `${DOCS}/instagram-graph-api/reference/ig-user/business_discovery`,
  },
  {
    key: 'safety', requirement: '5-safety', title: 'זיהוי שגיאות, מגבלות והרשאות + עצירה אוטומטית', support: 'automatic', providers: ['instagram_login', 'facebook_login'], permissions: {}, jobTypes: [],
    note: 'סיווג כל שגיאת Meta (טוקן, הרשאה, Rate limit, חסימת מדיניות), קריאת כותרות ניצול מכסה, השהיה לפני הגבול, מפסק זרם, ביטול משימות בחשבון לא תקין.',
    source: `${DOCS}/reference/error-codes`,
  },
  {
    key: 'publishing', requirement: 'extra', title: 'פרסום מתוזמן (תוספת — לא בדרישה המקורית)', support: 'automatic', providers: ['instagram_login', 'facebook_login'],
    permissions: { instagram_login: ['instagram_business_content_publish'], facebook_login: ['instagram_content_publish'] }, jobTypes: ['publish_post'],
    note: 'דורש כתובת שרת ציבורית ב-HTTPS.', source: `${DOCS}/content-publishing`,
  },
  {
    key: 'auto_replies', requirement: 'extra', title: 'מענה אוטומטי לתגובות והודעות (תוספת — לא בדרישה המקורית)', support: 'automatic', providers: ['instagram_login', 'facebook_login'],
    permissions: { instagram_login: ['instagram_business_manage_comments', 'instagram_business_manage_messages'], facebook_login: ['instagram_manage_comments', 'instagram_manage_messages'] },
    jobTypes: ['process_comment', 'poll_comments', 'process_dm'], note: 'הודעות דיירקט דורשות Webhooks.', source: `${DOCS}/webhooks`,
  },
];
