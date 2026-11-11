import { redirect } from 'next/navigation';

// Suppliers moved into Contacts in v2 (D96); old bookmarks land there.
export default function SuppliersPage() {
  redirect('/contacts?type=supplier');
}
