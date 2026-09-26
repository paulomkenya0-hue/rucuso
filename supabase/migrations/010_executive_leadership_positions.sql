-- Add the RUCUSO-wide executive posts as distinct leader positions.
alter table public.profiles drop constraint if exists profiles_position_check;
alter table public.profiles add constraint profiles_position_check
  check (position is null or position in (
    'president',
    'vice_president',
    'secretary_general',
    'prime_minister',
    'prime_minister_secretary',
    'deputy_secretary_general',
    'minister',
    'deputy_minister',
    'representative',
    'officer'
  ));
