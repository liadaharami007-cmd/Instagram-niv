import type { Provider } from './graph-client.ts';

export type Support = 'official' | 'official_fb_only' | 'manual';

export interface Capability {
  key: string;
  title: string;
  support: Support;
  permissions: Partial<Record<Provider, string[]>>;
  note: string;
}

/**
 * What the official Meta platform allows (Instagram Graph API, professional accounts).
 * Anything marked "manual" has NO official endpoint; the product runs it as a guided
 * human workflow and never automates it through unofficial means.
 */
export const CAPABILITIES: Capability[] = [
  {
    key: 'profile',
    title: 'נתוני פרופיל ומספר עוקבים',
    support: 'official',
    permissions: { instagram_login: ['instagram_business_basic'], facebook_login: ['instagram_basic', 'pages_show_list'] },
    note: 'followers_count / follows_count / media_count — נשמר כצילום מצב כל 3 שעות לבניית גרף צמיחה אמיתי.',
  },
  {
    key: 'insights',
    title: 'Insights: חשיפה, צפיות, מעורבות, עוקבים חדשים',
    support: 'official',
    permissions: { instagram_login: ['instagram_business_manage_insights'], facebook_login: ['instagram_manage_insights'] },
    note: 'follower_count זמין רק לחשבונות עם 100+ עוקבים ול-30 הימים האחרונים. follows_and_unfollows ע"פ Meta.',
  },
  {
    key: 'media',
    title: 'ביצועי פוסטים ורילס',
    support: 'official',
    permissions: { instagram_login: ['instagram_business_basic', 'instagram_business_manage_insights'], facebook_login: ['instagram_basic', 'instagram_manage_insights'] },
    note: 'reach / views / saved / shares / total_interactions לכל פוסט מ-30 הימים האחרונים.',
  },
  {
    key: 'stories_insights',
    title: 'נתוני הסטוריז שלך',
    support: 'official',
    permissions: { instagram_login: ['instagram_business_manage_insights'], facebook_login: ['instagram_manage_insights'] },
    note: 'סטוריז זמינים 24 שעות בלבד — המערכת שומרת אותם ואת נתוניהם כל 4 שעות.',
  },
  {
    key: 'business_discovery',
    title: 'מחקר קהל יעד ומתחרים (Business Discovery)',
    support: 'official_fb_only',
    permissions: { facebook_login: ['instagram_basic', 'pages_read_engagement'] },
    note: 'מספר עוקבים ופוסטים של חשבונות עסקיים/יוצרים אחרים. זמין רק בחיבור דרך Facebook Login.',
  },
  {
    key: 'publishing',
    title: 'פרסום מתוזמן: פוסטים, רילס וסטוריז',
    support: 'official',
    permissions: { instagram_login: ['instagram_business_content_publish'], facebook_login: ['instagram_content_publish'] },
    note: 'אוטומטי לגמרי בשעה שנקבעה. עד 100 פרסומים ב-24 שעות (מגבלת Meta). הקובץ חייב להיות נגיש ב-HTTPS ציבורי.',
  },
  {
    key: 'comment_replies',
    title: 'מענה אוטומטי לתגובות (ציבורי ובפרטי)',
    support: 'official',
    permissions: { instagram_login: ['instagram_business_manage_comments', 'instagram_business_manage_messages'], facebook_login: ['instagram_manage_comments', 'instagram_manage_messages'] },
    note: 'לפי מילות מפתח או לכל תגובה. בזמן אמת דרך Webhooks, או בבדיקה כל 15 דקות. מגבלה שעתית נגד ספאם.',
  },
  {
    key: 'dm_replies',
    title: 'מענה אוטומטי להודעות בדיירקט',
    support: 'official',
    permissions: { instagram_login: ['instagram_business_manage_messages'], facebook_login: ['instagram_manage_messages', 'pages_manage_metadata'] },
    note: 'הודעת פתיחה ותשובות לפי מילות מפתח. דורש Webhooks (כתובת ציבורית). Meta מתירה מענה עד 24 שעות מההודעה של הלקוח.',
  },
  {
    key: 'follow',
    title: 'Follow — מעקב אחרי חשבונות',
    support: 'manual',
    permissions: {},
    note: 'אין API רשמי לביצוע Follow. המערכת מתכננת רשימה יומית בטוחה, פותחת את הפרופיל באינסטגרם, ומתעדת רק מה שאושר שבוצע.',
  },
  {
    key: 'unfollow',
    title: 'Unfollow — הסרת מעקב לפי כללים',
    support: 'manual',
    permissions: {},
    note: 'אין API רשמי לביצוע Unfollow או לרשימת עוקבים. זיהוי "לא עוקב בחזרה" מתבסס על קובץ ההורדה הרשמי של אינסטגרם.',
  },
  {
    key: 'story_like',
    title: 'לייקים לסטוריז של אחרים',
    support: 'manual',
    permissions: {},
    note: 'אין API רשמי ללייק על סטורי. המערכת מנהלת תור ביצוע ידני עם קצב בטוח ותיעוד.',
  },
];
