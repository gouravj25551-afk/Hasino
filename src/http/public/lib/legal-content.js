/*
 * The legal documents, as structured data rendered by views/legal.js.
 *
 * PRIVACY is Hasino's Privacy Policy, transcribed from the approved PDF so the
 * in-app page and the document stay the same words. TERMS is the Terms &
 * Conditions — a first draft in the same register as the policy; it has NOT
 * been through legal review, and it deliberately does not state specific
 * cancellation or refund figures, which are to be defined separately.
 *
 * Block shapes a section understands:
 *   { p: 'text' }            a paragraph
 *   { ul: ['a', 'b'] }       a bullet list
 *   { lead: 'Label', p: '' } a bolded lead-in followed by text
 */

const UPDATED = 'Last updated: September 2, 2026';

export const PRIVACY = {
  id: 'privacy',
  title: 'Privacy Policy',
  updated: UPDATED,
  intro: [
    'This Privacy Policy explains how HASINO ("HASINO", "we", "us", or "our") collects, uses, stores, discloses, and otherwise processes personal information when you access or use our website, mobile application, platform, and related services (collectively, the "Services").',
    'HASINO is a beauty and wellness platform that enables users to discover, compare, and book services from salons, spas, barbers, nail studios, skin clinics, and other beauty and wellness businesses. For businesses, HASINO provides tools to manage appointments, customers, services, and business operations.',
    'By accessing or using the Services, you acknowledge that you have read and understood this Privacy Policy.',
  ],
  sections: [
    { n: '1', title: 'Information we collect', blocks: [
      { p: 'We collect personal information that is reasonably necessary to provide, maintain, secure, and improve the Services, comply with applicable law, and perform the activities described in this Privacy Policy. The information we collect depends on how you use HASINO.' },
      { lead: 'Information you provide.', p: 'When creating an account, making a booking, registering a business, or contacting us, this may include your name, mobile phone number, email address, account and authentication information, and any profile information you choose to provide.' },
      { lead: 'Booking information.', p: 'When you make or manage an appointment, we may collect the business you book with, services selected, appointment date and time, booking status, cancellation and refund information, booking reference numbers, and other information you provide in connection with a booking.' },
      { lead: 'Business information.', p: 'If you register or operate a business on HASINO, we may collect the business name, address, contact details, services offered, prices, operating hours, photographs and other content, and information reasonably required to verify or operate the business.' },
      { lead: 'Communications.', p: 'If you contact us, we may collect your name, contact information, the contents of your communication, and information reasonably necessary to respond.' },
      { lead: 'Information collected automatically.', p: 'When you use the Services we may automatically collect technical and usage information such as IP address, device type, operating system, browser type, application version, general device information, language and regional settings, date and time of access, basic diagnostic and error information, security-related logs, and information about your interactions with the Services.' },
      { lead: 'Information from third parties.', p: 'We may receive information from payment service providers, maps and location providers, technology and infrastructure providers, businesses using HASINO, and providers supporting authentication, communications, security, or notifications, where reasonably necessary to provide or operate the Services.' },
    ]},
    { n: '2', title: 'Payment information', blocks: [
      { p: 'When you make a payment through HASINO, payment processing may be provided by Cashfree Payments India Private Limited ("Cashfree") or another payment service provider we may use in the future.' },
      { p: 'We may receive transaction-related information such as transaction ID, payment status, amount paid, booking or payment reference, refund status, transaction date and time, and other information reasonably necessary to reconcile or manage the transaction.' },
      { p: 'Where payment details are entered directly into the payment service provider’s interface, HASINO does not intentionally store complete payment-card credentials such as the full card number, CVV, UPI PIN, or similar authentication credentials on its own servers. Payment service providers may independently process payment information under their own terms, privacy policies, and applicable law.' },
    ]},
    { n: '3', title: 'Location information', blocks: [
      { p: 'HASINO provides location-based functionality to help users discover businesses near a selected location. If you grant permission, we may access your approximate or precise device location, latitude and longitude, or a location you manually select or search for.' },
      { p: 'We may use location information to show nearby businesses, sort or display businesses by location, support maps and directions, and improve location-based search. You can control device-location permissions through your device settings.' },
    ]},
    { n: '4', title: 'Google Maps Platform', blocks: [
      { p: 'HASINO may use Google Maps Platform services, including Maps, Places, or other location-related APIs, to provide maps, business discovery, search, and location-based functionality. HASINO’s use of information received through Google APIs is subject to applicable Google API requirements and policies. Google may independently process information under its own policies and terms.' },
    ]},
    { n: '5', title: 'Device and technical information', blocks: [
      { p: 'Certain technical information may be automatically generated or collected, including IP address, device type, operating system, browser type, application version, general device information, language and regional settings, date and time of access, diagnostic and error information, and information relating to security events.' },
      { p: 'We may use this information for security, fraud prevention, troubleshooting, maintaining and improving the Services, monitoring reliability, and preventing abuse. We do not use technical information to create targeted advertising profiles unless separately disclosed and carried out in accordance with applicable law.' },
    ]},
    { n: '6', title: 'Push notifications', blocks: [
      { p: 'If you grant permission, HASINO may send push notifications relating to bookings, appointment reminders, booking confirmations, cancellations, refunds, account activity, and important Service updates. You can disable push notifications through your device settings, though this may affect certain real-time notifications.' },
    ]},
    { n: '7', title: 'Cookies and similar technologies', blocks: [
      { p: 'HASINO may use cookies, local storage, session technologies, and similar technologies for authentication, maintaining login sessions, security, remembering preferences, maintaining basic functionality, diagnosing technical issues, and understanding Service performance.' },
      { p: 'We do not currently use cookies or similar tracking technologies for targeted advertising. If this changes, we will update this Privacy Policy and, where required by law, provide appropriate notice or obtain consent.' },
    ]},
    { n: '8', title: 'How we use your information', blocks: [
      { p: 'We may process personal information to provide the Services (create and manage accounts, allow discovery of businesses, display services and prices, facilitate bookings, manage appointments, process or facilitate payments, process cancellations and refunds, provide confirmations and reminders, and provide support).' },
      { p: 'We may also use information to operate and improve HASINO, for security and fraud prevention, and for legal and regulatory purposes such as complying with applicable law, responding to lawful requests, and establishing, exercising, or defending legal claims. Where reasonably possible, we may use aggregated or de-identified information for these purposes.' },
    ]},
    { n: '9', title: 'Consent and other grounds for processing', blocks: [
      { p: 'Depending on the nature of the information, the purpose of processing, and applicable law, HASINO may process personal information with your consent or where processing is otherwise permitted or required by law. Where we rely on consent, you may withdraw it subject to applicable law and any consequences that necessarily result. Withdrawal does not affect the lawfulness of processing carried out before the withdrawal.' },
    ]},
    { n: '10', title: 'When we share personal information', blocks: [
      { p: 'We do not sell personal information for monetary consideration. We may disclose or share personal information where reasonably necessary to provide the Services, complete transactions, protect users, operate our business, or comply with applicable law.' },
      { lead: 'Businesses you book with.', p: 'When you book, we may provide the business information reasonably necessary to fulfil and manage your appointment — such as your name, contact information, service booked, appointment date and time, booking reference, and status. Businesses may independently process this information under their own privacy practices.' },
      { lead: 'Payment service providers.', p: 'We may share payment-related information with providers such as Cashfree to facilitate payments, refunds, transaction processing and reconciliation, fraud prevention, and payment-related support.' },
      { lead: 'Other providers.', p: 'We may share information with maps and location providers (including Google Maps Platform) and with technology and infrastructure providers for cloud infrastructure, database services, hosting, authentication, security, communications, push notifications, monitoring, and support. We may also disclose information where reasonably necessary to comply with law, respond to valid legal processes, protect rights or safety, or investigate fraud or security issues, and as part of a merger, acquisition, or similar business transaction.' },
    ]},
    { n: '11', title: 'Data retention', blocks: [
      { p: 'We retain personal information only for as long as reasonably necessary for the purposes described in this Privacy Policy, unless a longer period is required or permitted by law. Retention may depend on the nature of the information, the purpose of collection, whether your account remains active, ongoing bookings, security and fraud-prevention requirements, legal and accounting requirements, and the resolution of disputes. Some information may remain temporarily in backup systems before being permanently deleted.' },
    ]},
    { n: '12', title: 'Account deletion', blocks: [
      { p: 'You may request deletion of your HASINO account through the account-deletion functionality made available to you or by contacting us. When a request is accepted, we take reasonable steps to delete or anonymize personal information from our active systems, subject to applicable law and legitimate retention requirements (for example, to comply with legal, accounting, tax, or regulatory obligations, document financial transactions, prevent fraud, or resolve disputes). Deletion may not immediately remove every record where retention is legally or operationally necessary.' },
    ]},
    { n: '13', title: 'Data security', blocks: [
      { p: 'We take reasonable technical and organizational measures designed to protect personal information against unauthorized access, loss, misuse, alteration, or disclosure — which may include access and authentication controls, encryption where appropriate, secure communication protocols, monitoring and logging, restricted access, and security testing. However, no method of transmission or electronic storage is completely secure, and we cannot guarantee absolute security.' },
    ]},
    { n: '14', title: 'Your privacy rights', blocks: [
      { p: 'Subject to applicable law, you may have rights concerning your personal information, including to request access, request correction of inaccurate or incomplete information, request deletion where legally applicable, withdraw consent where consent is the basis for processing, request information about our processing, and raise a complaint. The availability, scope, and method of exercising these rights may depend on applicable law and the circumstances of the processing.' },
      { p: 'To exercise these rights, contact us at privacy.hasino@gmail.com. We may need to verify your identity before acting on certain requests, and we will handle requests in accordance with applicable law.' },
    ]},
    { n: '15', title: 'Children’s privacy', blocks: [
      { p: 'HASINO is intended for users who are legally permitted to use the Services under applicable law. We do not knowingly collect personal information from children where such collection is prohibited by law. If you believe a child has provided personal information to HASINO in such circumstances, please contact us at privacy.hasino@gmail.com and we will take reasonable steps to address it.' },
    ]},
    { n: '16', title: 'Third-party websites and services', blocks: [
      { p: 'The Services may contain links to third-party websites, applications, or services. HASINO is not responsible for the privacy practices, content, security, or policies of third-party services it does not operate or control. We encourage you to review their privacy policies and terms before providing them with personal information.' },
    ]},
    { n: '17', title: 'Changes to this Privacy Policy', blocks: [
      { p: 'We may update this Privacy Policy from time to time to reflect changes to our Services, data practices, technology, applicable law, or business operations. When we make changes, we will update the "Last updated" date above, and where required by law we may provide additional notice of material changes.' },
    ]},
    { n: '18', title: 'Grievance and contact', blocks: [
      { p: 'For privacy-related questions, concerns, requests, or complaints, contact HASINO at privacy.hasino@gmail.com.' },
      { p: 'HASINO — India. Postal address: 22/635, Rambagh Colony, Baraut, Baghpat, Uttar Pradesh, India.' },
    ]},
  ],
};

export const TERMS = {
  id: 'terms',
  title: 'Terms & Conditions',
  updated: UPDATED,
  intro: [
    'These Terms & Conditions ("Terms") govern your access to and use of HASINO’s website, mobile application, platform, and related services (collectively, the "Services"). By creating an account, signing in, or otherwise using the Services, you agree to these Terms and to our Privacy Policy. If you do not agree, please do not use the Services.',
    'HASINO is a beauty and wellness platform that lets you discover and book services from independent salons, spas, barbers, nail studios, skin clinics, and similar businesses ("Businesses"). HASINO is a marketplace and booking platform — the beauty and wellness services themselves are provided by the Businesses, not by HASINO.',
  ],
  sections: [
    { n: '1', title: 'Who can use HASINO', blocks: [
      { p: 'You may use the Services only if you are legally permitted to enter into a binding agreement under applicable law and are of the age required to do so in your jurisdiction. By using the Services you confirm that you meet these requirements and that the information you provide is accurate and current.' },
    ]},
    { n: '2', title: 'Your account', blocks: [
      { p: 'You sign in to HASINO using a third-party sign-in provider (currently Google). You are responsible for the account you sign in with and for activity that occurs under your HASINO account. Keep your sign-in credentials secure, and contact us if you believe your account has been used without your permission.' },
      { p: 'Listing a business opens a request that a HASINO administrator reviews; only an approval turns your account into a Business account. Until then it remains an ordinary customer account.' },
    ]},
    { n: '3', title: 'Bookings', blocks: [
      { p: 'When you book, HASINO shows the Business, the services you selected, the date and time, the price, and the booking status. Availability shown in the app reflects the Business’s configured hours and capacity and may change; a slot is confirmed only once your booking is confirmed. The Business is responsible for actually performing the booked service.' },
      { p: 'You agree to provide accurate booking details and to arrive for confirmed appointments on time. HASINO is not responsible for a Business’s decision to accept, decline, reschedule, or cancel an appointment, though we provide tools that support these actions.' },
    ]},
    { n: '4', title: 'Prices, the booking advance, and payment', blocks: [
      { p: 'Service prices are set by each Business and shown in the app. Where online payment is enabled, booking may require you to pay an advance — a portion of the total (currently 30%) shown to you at the time of booking — to confirm your appointment, with the remaining balance payable directly to the Business at the time of service.' },
      { p: 'The advance is a booking advance intended to confirm your appointment and reduce no-shows. It is not a HASINO service fee, commission, or platform charge. The exact amount payable now and the amount payable to the Business are shown before you confirm.' },
      { p: 'Where online payment is provided, it may be processed by Cashfree Payments India Private Limited or another payment service provider, subject to their terms. HASINO does not intentionally store your full payment-card or UPI credentials on its own servers.' },
    ]},
    { n: '5', title: 'Cancellations, refunds, and no-shows', blocks: [
      { p: 'Cancellation, rescheduling, refund, and no-show terms, where applicable, are as shown to you at the time of booking or as otherwise published or notified by HASINO. Any advance you pay is handled in accordance with those terms and applicable law. Repeated missed appointments may affect your ability to book.' },
    ]},
    { n: '6', title: 'Businesses on HASINO', blocks: [
      { p: 'If you operate a Business on HASINO, you are responsible for the accuracy of your listing, services, prices, hours, and content, for honouring confirmed bookings, and for performing services lawfully and to the standard a customer would reasonably expect. You grant HASINO permission to display your listing and content within the Services for the purpose of operating the platform.' },
    ]},
    { n: '7', title: 'Acceptable use', blocks: [
      { p: 'You agree not to misuse the Services — including by providing false information, interfering with the platform’s operation or security, attempting unauthorized access, using the Services for unlawful purposes, or infringing the rights of others. We may limit, suspend, or remove access that breaches these Terms or applicable law.' },
    ]},
    { n: '8', title: 'Intellectual property', blocks: [
      { p: 'The HASINO name, logo, software, and the design and content of the Services (other than content owned by Businesses or users) are the property of HASINO or its licensors and are protected by applicable law. These Terms do not grant you any right to use HASINO’s branding except as necessary to use the Services as intended.' },
    ]},
    { n: '9', title: 'Third-party services', blocks: [
      { p: 'The Services rely on third parties — including sign-in, payment, maps and location, hosting, communications, and security providers. Your use of certain features may also be subject to those providers’ terms and privacy policies. HASINO is not responsible for third-party services it does not operate or control.' },
    ]},
    { n: '10', title: 'Service availability', blocks: [
      { p: 'We aim to keep the Services available and working, but we provide them on an "as is" and "as available" basis. We do not guarantee that the Services will be uninterrupted, error-free, or always available, and we may modify, suspend, or discontinue features from time to time.' },
    ]},
    { n: '11', title: 'Disclaimers', blocks: [
      { p: 'HASINO is a platform that connects you with independent Businesses. We do not provide beauty or wellness services ourselves and do not guarantee the quality, safety, suitability, or outcome of any service provided by a Business. Any dispute about a service is primarily between you and the Business, though we may provide reasonable assistance.' },
    ]},
    { n: '12', title: 'Limitation of liability', blocks: [
      { p: 'To the maximum extent permitted by applicable law, HASINO will not be liable for indirect, incidental, special, or consequential losses, or for the acts or omissions of Businesses or other third parties. Nothing in these Terms excludes any liability that cannot be excluded under applicable law.' },
    ]},
    { n: '13', title: 'Indemnity', blocks: [
      { p: 'You agree to indemnify and hold HASINO harmless from claims, losses, and expenses arising from your misuse of the Services or your breach of these Terms or applicable law, to the extent permitted by law.' },
    ]},
    { n: '14', title: 'Suspension and termination', blocks: [
      { p: 'We may suspend or terminate your access to the Services if you breach these Terms or applicable law, or where reasonably necessary to protect users, Businesses, or the platform. You may stop using the Services at any time and may request deletion of your account as described in the Privacy Policy.' },
    ]},
    { n: '15', title: 'Changes to these Terms', blocks: [
      { p: 'We may update these Terms from time to time to reflect changes to the Services, our practices, or applicable law. When we make changes we will update the "Last updated" date above, and where required by law we may provide additional notice. Your continued use of the Services after changes take effect means you accept the updated Terms.' },
    ]},
    { n: '16', title: 'Governing law', blocks: [
      { p: 'These Terms are governed by the laws of India, and you agree to the jurisdiction of the courts of India, subject to applicable law.' },
    ]},
    { n: '17', title: 'Contact', blocks: [
      { p: 'For questions about these Terms, contact HASINO at privacy.hasino@gmail.com.' },
      { p: 'HASINO — India. Postal address: 22/635, Rambagh Colony, Baraut, Baghpat, Uttar Pradesh, India.' },
    ]},
  ],
};
