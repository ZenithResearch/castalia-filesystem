# Distribution review for the filesystem candidate

The portable code retains its observed **AGPL-3.0-or-later** declaration and the unmodified license text in `LICENSE`. Third-party declarations and notices remain separately recorded. This document records release work to check; passing its byte-integrity checks is not a legal-clearance conclusion or a grant for inherited code.

Before conveying a covered modified version or object-code application, the distributor must review the applicable terms in LICENSE, including sections 4–6, and the network-interaction condition in section 13 where applicable. In particular:

- Preserve copyright, license and warranty notices, including applicable third-party notices. Record modifications and their relevant dates; see CHANGELOG.md and immutable source history.
- Identify the covered combined work and the applicable license terms. Package boundaries alone do not decide that question. Do not infer a new license for inherited source or third-party components from the root package metadata.
- Provide the required machine-readable Corresponding Source through an applicable license mechanism. Record the exact maintained source commit, dependency locks, build scripts, binding tools and modifications needed to generate the delivered object code. A transient CI artifact or a commit link alone is not a determination that the complete source-delivery obligation is met.
- Check applicable interactive legal notices and, when section 13 applies, a prominent opportunity for remote users to receive Corresponding Source. Browser-local operation alone does not settle obligations of a later combined application.
- Review the actual consumer distribution and its policy separately. Do not equate an allowed dependency declaration, generated notice inventory or successful build with clearance of missing source permissions.

The complete candidate manifest binds its own maintained source revision and all shipped notice bytes. `provenance/notices.json` binds the runtime-notice evidence to the reviewed WASM/binding-tool locks. Compiler and generator information appears in that manifest and `provenance/build-tools.json`. The source repository includes the build scripts and original fixture/parity code; no native bridge, private history, credential or owner attestation is shipped by this change.

The candidate remains private package metadata with no registry publication or deployment workflow. Real source-permission questions remain explicit; no additional grant is created by this checklist. The full license text controls over this engineering summary.
