# Budget Tracker 2026

A personal budget app with Pach. Install: open the site in Safari, tap Share, then Add to Home Screen.

Your budget data is saved on your own phone, never in this repository.

## Recipe Box

A second app lives in `recipes/`. Install it the same way from `recipes/` on the site. It signs in with the same account and shares the same space as the budget. Setup: run `recipes-setup.sql` in Supabase, then deploy `supabase/functions/recipe-import` (reads recipes from links) and `supabase/functions/recipe-deals` (weekly flyer deals from Flipp's search, run by Supabase Cron). Both are free; no API key.

## Together

A third app lives in `couples/`: a shared weekly calendar for you and your partner. Install it the same way from `couples/` on the site. It signs in with the same account, and your partner is the other person in the same shared space as the budget, so if you're already connected there you're connected here. Setup: run `couples-setup.sql` in Supabase once.

- **Home** shows the next time you're both free, and the free stretches coming up over the next two weeks.
- **Week** shows each day as two lanes, yours and your partner's, with the times you're both free highlighted.
- **Profile** sets your name, colour, the hours of the day you count as free time, and the shortest gap worth showing. Connect with your partner here using an invite code.
- The **+** button adds an event to your own calendar. You can see your partner's events but only change your own.
