UPDATE "users"
SET "avatarColor" = CASE "avatarColor"
  WHEN '#5b7cfa' THEN '#2e2e2e'
  WHEN '#3ab7a3' THEN '#404040'
  WHEN '#e0803c' THEN '#525252'
  WHEN '#d4577b' THEN '#636363'
  WHEN '#8c6ff0' THEN '#757575'
  WHEN '#4aa3df' THEN '#2e2e2e'
  WHEN '#9bb43a' THEN '#404040'
  WHEN '#c9a227' THEN '#525252'
  WHEN '#e05d5d' THEN '#636363'
  WHEN '#6d8699' THEN '#757575'
  ELSE '#525252'
END;
