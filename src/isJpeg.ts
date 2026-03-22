export function isJPEGBase64(base64String: string) {
	// Remove possible data URI scheme prefix
	const cleanBase64 = base64String.replace(/^data:image\/jpeg;base64,/, '');

	// Decode base64 to byte array
	const binary = atob(cleanBase64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}

	// Check JPEG file header (SOI - Start of Image)
	// JPEG starts with FF D8
	if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
		return {
			isValid: false,
			reason: 'Invalid JPEG header (missing SOI marker)'
		};
	}

	// Check JPEG file tail (EOI - End of Image)
	// JPEG ends with FF D9
	if (bytes[bytes.length - 2] !== 0xFF || bytes[bytes.length - 1] !== 0xD9) {
		return {
			isValid: false,
			reason: 'Invalid JPEG footer (missing EOI marker)'
		};
	}

	return {
		isValid: true,
		reason: 'Valid JPEG format'
	};
}
