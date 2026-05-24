-- New AppFolio sync — insert 2 San Diego properties + 31 units, drop 7 stale properties.
INSERT INTO properties (id, workspace_id, name, address, city, state, postal_code, country, appfolio_property_id, appfolio_property_number)
VALUES
  ('d307b2b2-d061-4cb7-96a3-20d150a35e33', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', '4053-55 Hamilton St', '4053-55 Hamilton Street San Diego, CA 92104', 'San Diego', 'CA', '92104', 'USA', '211', '301'),
  ('b74bee77-f7e4-4378-962d-e8923b311b78', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', '4480 49th St', '4480 49th Street San Diego, CA 92115', 'San Diego', 'CA', '92115', 'USA', '212', '302');

INSERT INTO units (id, workspace_id, property_id, name, appfolio_unit_id)
VALUES
  ('848820f2-9c50-47ad-8cf7-189ae0135195', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 1 4055 Hamilton St', '1077'),
  ('a412f8b6-8c99-4101-8bdb-3794a018dc9c', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 2 4055 Hamilton St', '1078'),
  ('2a705d8b-ac7f-464c-9c46-cf976b81c22f', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 3 4055 Hamilton St', '1079'),
  ('fb98d67c-493b-4625-80b0-db22ffffa3e6', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 4 4055 Hamilton St', '1080'),
  ('0f6de2aa-7bfb-41e5-8be8-fa51488935d8', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 5 4055 Hamilton St', '1081'),
  ('bb78de91-a228-4c4f-bb19-18a35825c90d', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 6 4055 Hamilton St', '1082'),
  ('4a32a408-0867-4508-b159-d6539d44b882', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 7 4055 Hamilton St', '1083'),
  ('80f9b29b-6783-4786-98f2-a9f67e4ae830', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 8 4055 Hamilton St', '1084'),
  ('f7e80ac7-cfef-4b2c-b404-3e1a8ea23bbc', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 9 4055 Hamilton St', '1085'),
  ('39faeae8-39ac-40a7-b9d9-3f10dd171d3c', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 10 4055 Hamilton St', '1086'),
  ('7fe0906a-cca5-453e-87ae-31ce7ff2ecda', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 11 4055 Hamilton St', '1087'),
  ('da9b857a-104e-4e05-8e27-161152d7ec14', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 12 4055 Hamilton St', '1088'),
  ('4b53c67e-024a-409e-9f3b-a9c5ceb48fcd', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 14 4055 Hamilton St', '1089'),
  ('2e7d4de7-b346-44e5-b8ed-b3746dd3e91a', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', '4053 Hamilton St', '1090'),
  ('37b1c345-0987-43f4-88c7-678f7d6f1dcf', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'd307b2b2-d061-4cb7-96a3-20d150a35e33', 'Unit 15 4055 Hamilton St', '1091'),
  ('13aa7457-d456-459d-8dbe-d6a97d41e55f', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 1 4480 49th St', '1092'),
  ('923368ce-7152-41f1-83e0-4fcbd8e71401', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 2 4480 49th St', '1093'),
  ('b9048e74-8168-4df4-9a7b-c578b9c3864a', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 3 4480 49th St', '1094'),
  ('1270aabd-9370-4ffa-8708-a750a71c96e1', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 4 4480 49th St', '1095'),
  ('f0cd0fcb-7179-4158-b103-498850c0f75e', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 5 4480 49th St', '1096'),
  ('1154294a-23b3-45aa-b02a-769295676522', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 6 4480 49th St', '1097'),
  ('eb4a46fa-b2c3-4750-b475-d50a25949aec', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 7 4480 49th St', '1098'),
  ('d721e4e9-3669-4cde-93b6-55a92934a33b', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 8 4480 49th St', '1099'),
  ('ca37c3ba-060b-470f-b505-ece0c88d5557', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 9 4480 49th St', '1100'),
  ('02401e94-018b-4f9f-85e6-6501f4a57770', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 10 4480 49th St', '1101'),
  ('44d038b1-ebbc-4929-9b83-a8176f8df5e3', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 11 4480 49th St', '1102'),
  ('8697c10b-d657-4e48-b394-c2597e40148a', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 12 4480 49th St', '1103'),
  ('7c4a8b78-c929-4863-9933-0dff4189a1e4', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 14 4480 49th St', '1104'),
  ('c8367ad2-ebf2-4455-a363-a1f2677cac91', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 15 4480 49th St', '1105'),
  ('db87edd2-ae38-4cbc-a41d-e9cb59f509a2', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 16 4480 49th St', '1106'),
  ('6f35f876-990b-46bb-a00d-0b6bf9e90a2c', '2e4373a0-40b8-42c2-a873-b08c99dbf76a', 'b74bee77-f7e4-4378-962d-e8923b311b78', 'Unit 17 4480 49th St', '1107');

DELETE FROM owner_properties WHERE property_id IN (
  'a6fba81a-cac4-45e2-a5bc-734d6932d4aa',
  'af30961d-e672-41e4-a3c1-a0b47b4b68b5',
  '5c1e3061-3148-4025-a5ce-94b6feafd8ba',
  '67b1f6a7-ddbe-44ee-8c6e-e0086c2b3832',
  'bc4cd11f-1828-41f7-a5b9-bb2ded8c3fe8',
  '991c0a44-7572-4553-b3a1-8757005e9d33',
  '26c3a9ab-1209-464d-8110-76d7ea50157b'
);

DELETE FROM properties WHERE id IN (
  'a6fba81a-cac4-45e2-a5bc-734d6932d4aa',
  'af30961d-e672-41e4-a3c1-a0b47b4b68b5',
  '5c1e3061-3148-4025-a5ce-94b6feafd8ba',
  '67b1f6a7-ddbe-44ee-8c6e-e0086c2b3832',
  'bc4cd11f-1828-41f7-a5b9-bb2ded8c3fe8',
  '991c0a44-7572-4553-b3a1-8757005e9d33',
  '26c3a9ab-1209-464d-8110-76d7ea50157b'
) AND workspace_id = '2e4373a0-40b8-42c2-a873-b08c99dbf76a';
