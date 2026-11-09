export function studentNameParts(first: string, last: string) {
  const firstName = first.trim().replace(/\s+/g, " ").toUpperCase()
  const lastName = last.trim().replace(/\s+/g, " ").toUpperCase()
  if (!firstName) throw new Error("Enter your first name.")
  if (!lastName) throw new Error("Enter your last name.")
  if (firstName.length > 60 || lastName.length > 60 || `${firstName} ${lastName}`.length > 120) {
    throw new Error("Keep each name within 60 characters and your combined name within 120 characters.")
  }
  return { firstName, lastName }
}
