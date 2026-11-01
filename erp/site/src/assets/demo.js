// "Book a demo" (B7a): nothing is sent to a server. The details become a WhatsApp message (or an email) that the
// visitor sends themselves, so no personal data is stored by the website.
(function () {
  var form = document.getElementById('demo-form');
  if (!form) return;
  var result = document.getElementById('demo-result');
  var waLink = document.getElementById('demo-wa');
  var mailLink = document.getElementById('demo-mail');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!form.reportValidity()) return;
    var f = form.elements;
    var lines = [
      'Hello, I would like a demo.',
      'Name: ' + f.name.value.trim(),
      'Phone: ' + f.phone.value.trim(),
      'Business: ' + f.business.value.trim(),
      'City: ' + f.city.value.trim(),
      f.sells.value.trim() ? 'We sell: ' + f.sells.value.trim() : '',
      f.message.value.trim() ? 'Message: ' + f.message.value.trim() : '',
    ].filter(Boolean);
    var text = lines.join('\n');
    var number = form.getAttribute('data-whatsapp') || '';
    var email = form.getAttribute('data-email') || '';

    var validNumber = /^\d{10,15}$/.test(number);
    if (validNumber) waLink.href = 'https://wa.me/' + number + '?text=' + encodeURIComponent(text);
    waLink.hidden = !validNumber;
    var validEmail = /^[^@\s]+@[^@\s]+$/.test(email);
    if (validEmail) {
      mailLink.href = 'mailto:' + email + '?subject=' + encodeURIComponent('Demo request: ' + f.business.value.trim()) +
        '&body=' + encodeURIComponent(text);
    }
    mailLink.hidden = !validEmail;
    result.hidden = false;
    if (validNumber) window.open(waLink.href, '_blank', 'noopener');
    result.focus();
  });
})();
