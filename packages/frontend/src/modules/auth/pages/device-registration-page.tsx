import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { IconAlertCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

interface ValidationResult {
  available: boolean;
  dnsAvailable: boolean;
  tunnelNameAvailable: boolean;
  hostname?: string;
  tunnelName?: string;
  errors: string[];
  error?: string; // General error if validation couldn't complete
}

export default function DeviceRegistrationPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [organizationId, setOrganizationId] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [isRegistered, setIsRegistered] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Check registration status on mount
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/registration/status');
        if (res.ok) {
          const data = await res.json();
          if (data.registered) {
            setIsRegistered(true);
            navigate('/');
          }
        }
      } catch (e) {
        console.error(e);
      }
    };

    checkStatus();
  }, [navigate]);

  // Validate organization name when it changes
  const validateOrganizationName = useCallback(async (name: string) => {
    if (!name.trim()) {
      setValidationResult(null);
      setValidationError(null);
      return;
    }

    setIsValidating(true);
    setValidationError(null);

    try {
      const res = await fetch(`/api/registration/validate?name=${encodeURIComponent(name.trim())}`);
      
      if (!res.ok) {
        // Handle HTTP errors
        if (res.status === 0 || res.status >= 500) {
          setValidationError('Backend server is not available. Please make sure the backend is running.');
        } else {
          const errorData = await res.json().catch(() => ({}));
          setValidationError(errorData.error || 'Failed to validate organization name');
        }
        setValidationResult(null);
        return;
      }

      const data: ValidationResult = await res.json();
      setValidationResult(data);
      
      // If there's a general error in the response, show it
      if (data.error && !data.errors.length) {
        setValidationError(data.error);
      }
    } catch (error) {
      // Handle network errors (connection refused, etc.)
      if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
        setValidationError('Cannot connect to backend server. Please make sure the backend is running on port 3000.');
      } else {
        setValidationError('Error validating organization name. Please try again.');
      }
      setValidationResult(null);
    } finally {
      setIsValidating(false);
    }
  }, []);

  // Debounced validation
  useEffect(() => {
    if (!organizationName.trim()) {
      setValidationResult(null);
      return;
    }

    const timeoutId = setTimeout(() => {
      validateOrganizationName(organizationName);
    }, 500); // Wait 500ms after user stops typing

    return () => clearTimeout(timeoutId);
  }, [organizationName, validateOrganizationName]);

  // Poll for registration status after submission
  useEffect(() => {
    if (!isRegistering || isRegistered) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/registration/status');
        if (res.ok) {
          const data = await res.json();
          if (data.registered) {
            setIsRegistered(true);
            setIsRegistering(false);
            toast.success('Device registered successfully!');
            navigate('/');
          }
        }
      } catch (e) {
        console.error(e);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isRegistering, isRegistered, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!organizationId.trim()) {
      toast.error('Organization ID is required');
      return;
    }

    if (!organizationName.trim()) {
      toast.error('Organization name is required');
      return;
    }

    // Validate organization name before submitting
    await validateOrganizationName(organizationName);
    if (validationResult && !validationResult.available) {
      toast.error('Please fix validation errors before submitting');
      return;
    }

    // If validation hasn't completed yet, wait for it
    if (isValidating) {
      toast.error('Please wait for validation to complete');
      return;
    }

    setIsRegistering(true);

    try {
      const res = await fetch('/api/registration/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          organization_id: organizationId.trim(),
          organization_name: organizationName.trim(),
        }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        toast.success('Registration initiated successfully! Setting up organization...');
        // Status polling will handle navigation
      } else {
        setIsRegistering(false);
        // Show detailed error message
        const errorMessage = data.message || 'Registration failed';
        toast.error(errorMessage, { duration: 5000 });
        
        // If error mentions conflicts, update validation
        if (errorMessage.includes('already exists') || errorMessage.includes('already in use')) {
          await validateOrganizationName(organizationName);
        }
      }
    } catch (error) {
      setIsRegistering(false);
      toast.error('Failed to register device');
      console.error(error);
    }
  };

  if (isRegistered) {
    return null; // Will navigate away
  }

  if (isRegistering) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-6 text-center">
      <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent"></div>
        <h1 className="text-2xl font-bold text-foreground">Registering Device...</h1>
      <p className="text-muted-foreground max-w-md">
          Please wait while we register your device with the cloud server and set up your organization.
        </p>
        <p className="text-sm text-muted-foreground">
          This may take a few moments...
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-6">
      <div className="card w-full max-w-md">
        <div className="card-body">
          <h1 className="text-2xl font-bold text-center mb-4">Device Registration</h1>
          <p className="text-muted-foreground text-center mb-6">
            Register this device with your CI Cloud organization to access the app store.
          </p>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Organization ID"
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
              placeholder="org-xyz789"
              required
              disabled={isRegistering}
              helpText="Your organization ID from CI Cloud"
            />
            
            <Input
              label="Organization Name"
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
              placeholder="acme-corp"
              required
              disabled={isRegistering}
              helpText="Organization name for subdomain (e.g., acme-corp.companionintel.com). This name must be unique across all registered hubs and will be used to create your Cloudflare connector."
              error={
                validationError || 
                (validationResult && !validationResult.available && validationResult.errors[0]) ||
                undefined
              }
            />
            
            {/* Show connection/backend errors */}
            {validationError && !validationResult && (
              <Alert variant="danger">
                <AlertDescription>
                  <div className="flex items-start gap-2">
                    <IconAlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    <span>{validationError}</span>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* Show validation errors */}
            {validationResult && !validationResult.available && validationResult.errors.length > 0 && (
              <Alert variant="danger">
                <AlertDescription>
                  <div className="space-y-2">
                    {validationResult.errors.map((error, idx) => (
                      <div key={idx} className="flex items-start gap-2">
                        <IconAlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span className="flex-1">{error}</span>
                      </div>
                    ))}
                    {validationResult.hostname && (
                      <div className="text-sm mt-2 pl-6">
                        <strong>Subdomain:</strong> {validationResult.hostname}
                      </div>
                    )}
                    {validationResult.tunnelName && (
                      <div className="text-sm pl-6">
                        <strong>Connector Name:</strong> {validationResult.tunnelName}
                      </div>
                    )}
                  </div>
                </AlertDescription>
              </Alert>
            )}
            
            {/* Show success message */}
            {validationResult && validationResult.available && (
              <Alert variant="success">
                <AlertDescription>
                  ✓ Organization name is available. Subdomain: {validationResult.hostname}
                </AlertDescription>
              </Alert>
            )}
            
            <Button
              type="submit"
              intent="primary"
              className="w-full"
              loading={isRegistering || isValidating}
              disabled={
                !organizationId.trim() ||
                !organizationName.trim() ||
                isRegistering ||
                isValidating ||
                (validationResult !== null && !validationResult.available)
              }
            >
              {isValidating ? 'Validating...' : 'Register Device'}
            </Button>
          </form>
          
          <p className="text-xs text-muted-foreground mt-4 text-center">
            Make sure your CI Cloud backend is running on the configured URL (default: localhost:8001)
          </p>
        </div>
      </div>
    </div>
  );
}
