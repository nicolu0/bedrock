-- Hand-fix the 7 unit names that the auto-parser couldn't get right.
-- Truth confirmed against the AppFolio unit list for each property.
--
--   19 Ozone Ave (2 units): both are themselves street addresses ("19" and
--     "19 1/2 Ozone Ave"), no "Unit X" prefix needed.
--   2334 Oak St (1 unit): the row was incorrectly named "Unit 2334 2334 Oak St"
--     because its AppFolio unit_name duplicated the property number. The address
--     IS the unit identifier here — just store the street.
--   4641-4643 Pickford St (4 units): two had wrong street suffix (AppFolio
--     mixed "Ave" and "St" for the same property), two were mis-labelled with
--     the property range ("4641-4643") instead of their actual building number.
--     Per the AppFolio unit listing the canonical form for all 6 units uses "St".

UPDATE units SET name = '19 Ozone Ave', updated_at = now()
WHERE id = '9ee57d7b-4fac-42c5-ad29-d42a3834cae3';

UPDATE units SET name = '19 1/2 Ozone Ave', updated_at = now()
WHERE id = 'c39cf585-4146-4207-910f-4ecf875d16a1';

UPDATE units SET name = '2334 Oak St', updated_at = now()
WHERE id = '553cf699-badd-4661-be12-515e154ee050';

UPDATE units SET name = '4641 1/2 Pickford St', updated_at = now()
WHERE id = 'e06def10-0a1f-4040-b1df-8915b89a1d86';

UPDATE units SET name = '4643 Pickford St', updated_at = now()
WHERE id = '65c18043-e90b-4e74-9c85-776a9365e5b4';

UPDATE units SET name = '4643 1/2 Pickford St', updated_at = now()
WHERE id = '181d1993-8173-4681-b1ca-bea1efb32ec9';

UPDATE units SET name = '4645 Pickford St', updated_at = now()
WHERE id = 'fb8688b7-b365-429a-bf44-fa37d612670c';
